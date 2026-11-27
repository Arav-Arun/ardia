use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use serde_json::{json, Map, Value};

use crate::fsafe::{self, Dir, Entry, Fetched, Opened, Root};
use crate::migrate::{check_layout, overlapping, read_report, source_root, valid_run, Faults, Layout, Outcome, Sealer};
use crate::names;

pub const REPORT_VERSION: u64 = 1;
pub const STEP: &str = "chromium";
pub const LOCAL_STATE_LIMIT: u64 = 16 * 1024 * 1024;
pub const SPACE_MARGIN: u64 = 256 * 1024 * 1024;
pub const CHROMIUM_KEY_BYTES: usize = 32;
const PROGRESS_LIMIT: u64 = 4 * 1024 * 1024;
const REPORT_LIMIT: u64 = 1024 * 1024;
const DEPTH_LIMIT: usize = 48;
const COPY_WORKERS: usize = 4;
const COPY_BUFFER: usize = 1024 * 1024;
const DPAPI_PREFIX: &[u8] = b"DPAPI";
const ATTEMPT_CAP: u64 = 1_000_000;
const MEBIBYTE: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChromiumStage {
    Layout,
    Lock,
    InUse,
    LocalState,
    Scan,
    Space,
    Staging,
    Swap,
    Progress,
    Report,
    Marker,
}

const STAGES: [ChromiumStage; 11] = [
    ChromiumStage::Layout,
    ChromiumStage::Lock,
    ChromiumStage::InUse,
    ChromiumStage::LocalState,
    ChromiumStage::Scan,
    ChromiumStage::Space,
    ChromiumStage::Staging,
    ChromiumStage::Swap,
    ChromiumStage::Progress,
    ChromiumStage::Report,
    ChromiumStage::Marker,
];

impl ChromiumStage {
    pub fn as_str(self) -> &'static str {
        match self {
            ChromiumStage::Layout => "layout",
            ChromiumStage::Lock => "lock",
            ChromiumStage::InUse => "in_use",
            ChromiumStage::LocalState => "local_state",
            ChromiumStage::Scan => "scan",
            ChromiumStage::Space => "space",
            ChromiumStage::Staging => "staging",
            ChromiumStage::Swap => "swap",
            ChromiumStage::Progress => "progress",
            ChromiumStage::Report => "report",
            ChromiumStage::Marker => "marker",
        }
    }

    pub fn parse(text: &str) -> Option<ChromiumStage> {
        STAGES.into_iter().find(|stage| stage.as_str() == text)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChromiumCounts {
    pub profiles: u64,
    pub profiles_replaced: u64,
    pub webui_profiles_left: u64,
    pub files: u64,
    pub files_reused: u64,
    pub megabytes: u64,
    pub skipped_links: u64,
    pub skipped_invalid: u64,
    pub skipped_unreadable: u64,
    pub skipped_clash: u64,
    pub key_carried: u64,
    pub key_shared: u64,
    pub key_missing: u64,
    pub key_unreadable: u64,
    pub local_state_kept: u64,
    pub local_state_malformed: u64,
    pub staging_cleared: u64,
    pub partials_swept: u64,
}

impl ChromiumCounts {
    pub fn skipped(&self) -> u64 {
        self.skipped_links + self.skipped_invalid + self.skipped_unreadable + self.skipped_clash + self.key_unreadable
    }

    pub fn fields(&self) -> [(&'static str, u64); 18] {
        [
            ("profiles", self.profiles),
            ("profiles_replaced", self.profiles_replaced),
            ("webui_profiles_left", self.webui_profiles_left),
            ("files", self.files),
            ("files_reused", self.files_reused),
            ("megabytes", self.megabytes),
            ("skipped_links", self.skipped_links),
            ("skipped_invalid", self.skipped_invalid),
            ("skipped_unreadable", self.skipped_unreadable),
            ("skipped_clash", self.skipped_clash),
            ("key_carried", self.key_carried),
            ("key_shared", self.key_shared),
            ("key_missing", self.key_missing),
            ("key_unreadable", self.key_unreadable),
            ("local_state_kept", self.local_state_kept),
            ("local_state_malformed", self.local_state_malformed),
            ("staging_cleared", self.staging_cleared),
            ("partials_swept", self.partials_swept),
        ]
    }
}

#[derive(Clone, Debug)]
pub struct ChromiumReport {
    pub outcome: Outcome,
    pub failed_stage: Option<ChromiumStage>,
    pub counts: ChromiumCounts,
    pub duration_ms: u64,
    pub attempt: u64,
    pub prior_failed_stage: Option<ChromiumStage>,
    pub run: String,
}

impl ChromiumReport {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), json!(REPORT_VERSION));
        object.insert("step".into(), json!(STEP));
        object.insert("run".into(), json!(self.run));
        object.insert("outcome".into(), json!(self.outcome.as_str()));
        if let Some(stage) = self.failed_stage {
            object.insert("failed_stage".into(), json!(stage.as_str()));
        }
        object.insert("attempt".into(), json!(self.attempt));
        if let Some(stage) = self.prior_failed_stage {
            object.insert("prior_failed_stage".into(), json!(stage.as_str()));
        }
        object.insert("duration_ms".into(), json!(self.duration_ms));
        let counts: Map<String, Value> = self
            .counts
            .fields()
            .into_iter()
            .map(|(name, value)| (name.to_string(), json!(value)))
            .collect();
        object.insert("counts".into(), Value::Object(counts));
        Value::Object(object)
    }

    pub fn exit_code(&self) -> u8 {
        match self.outcome {
            Outcome::Migrated | Outcome::MigratedWithSkips | Outcome::AlreadyMigrated | Outcome::NothingToMigrate => 0,
            Outcome::Failed => 1,
            Outcome::Refused => 2,
            Outcome::Busy => 3,
        }
    }
}

fn of_step(report: &Value) -> bool {
    report.get("version").and_then(Value::as_u64) == Some(REPORT_VERSION)
        && report.get("step").and_then(Value::as_str) == Some(STEP)
        && valid_run(report)
        && report.get("attempt").is_some_and(Value::is_u64)
}

pub fn valid_chromium_marker(marker: &Value) -> bool {
    let finished = ["migrated", "migrated_with_skips", "nothing_to_migrate"];
    let counts_ok = marker.get("counts").and_then(Value::as_object).is_some_and(|counts| {
        ChromiumCounts::default()
            .fields()
            .iter()
            .all(|(name, _)| counts.get(*name).is_some_and(Value::is_u64))
    });
    of_step(marker)
        && marker
            .get("outcome")
            .and_then(Value::as_str)
            .is_some_and(|outcome| finished.contains(&outcome))
        && counts_ok
        && marker.get("failed_stage").is_none()
        && marker.get("duration_ms").is_some_and(Value::is_u64)
}

pub fn valid_chromium_attempt(report: &Value) -> bool {
    let written = [
        "failed",
        "busy",
        "migrated",
        "migrated_with_skips",
        "nothing_to_migrate",
    ];
    of_step(report)
        && report
            .get("outcome")
            .and_then(Value::as_str)
            .is_some_and(|outcome| written.contains(&outcome))
}

fn prior_failed_stage(previous: &Value) -> Option<ChromiumStage> {
    let stage_of = |field: &str| {
        previous
            .get(field)
            .and_then(Value::as_str)
            .and_then(ChromiumStage::parse)
    };
    let failed = matches!(previous.get("outcome").and_then(Value::as_str), Some("failed" | "busy"));
    failed
        .then(|| stage_of("failed_stage"))
        .flatten()
        .or_else(|| stage_of("prior_failed_stage"))
}

pub fn read_chromium_marker(webui_data: &std::path::Path) -> Option<Value> {
    read_report(&Root::new(webui_data).ok()?, names::CHROMIUM_MARKER_NAME).filter(valid_chromium_marker)
}

pub fn read_chromium_attempt(webui_data: &std::path::Path) -> Option<Value> {
    read_report(&Root::new(webui_data).ok()?, names::CHROMIUM_ATTEMPT_NAME)
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |byte: u8| -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let body = text.trim_end_matches('=');
    if text.len() - body.len() > 2 || body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.as_bytes().chunks(4) {
        let mut word = 0u32;
        for (index, byte) in chunk.iter().enumerate() {
            word |= value(*byte)? << (18 - 6 * index);
        }
        let bytes = word.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

pub fn chromium_key_opens(sealer: &dyn Sealer, encrypted_key: &str) -> bool {
    base64_decode(encrypted_key)
        .and_then(|bytes| bytes.strip_prefix(DPAPI_PREFIX).map(<[u8]>::to_vec))
        .and_then(|sealed| sealer.open_unbound(&sealed))
        .is_some_and(|plain| plain.len() == CHROMIUM_KEY_BYTES)
}

fn encrypted_key(local_state: &Map<String, Value>) -> Option<&str> {
    local_state.get("os_crypt")?.get("encrypted_key")?.as_str()
}

enum RnwKey {
    Missing,
    Unreadable,
    Ready { os_crypt: Value, encrypted_key: String },
}

impl RnwKey {
    fn encrypted_key(&self) -> Option<&str> {
        match self {
            RnwKey::Ready { encrypted_key, .. } => Some(encrypted_key),
            _ => None,
        }
    }
}

fn rnw_key(source: &Dir, sealer: &dyn Sealer) -> io::Result<RnwKey> {
    let bytes = match source.read(names::LOCAL_STATE, LOCAL_STATE_LIMIT)? {
        Fetched::Missing => return Ok(RnwKey::Missing),
        Fetched::Data(bytes) => bytes,
        _ => return Ok(RnwKey::Unreadable),
    };
    let Ok(Value::Object(state)) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(RnwKey::Unreadable);
    };
    let Some(key) = encrypted_key(&state).map(str::to_string) else {
        return Ok(RnwKey::Unreadable);
    };
    if !chromium_key_opens(sealer, &key) {
        return Ok(RnwKey::Unreadable);
    }
    Ok(RnwKey::Ready {
        os_crypt: state["os_crypt"].clone(),
        encrypted_key: key,
    })
}

enum WebUIState {
    Missing,
    Oversized,
    Malformed(Vec<u8>),
    Parsed(Vec<u8>, Map<String, Value>),
}

impl WebUIState {
    fn encrypted_key(&self) -> Option<&str> {
        match self {
            WebUIState::Parsed(_, state) => encrypted_key(state),
            _ => None,
        }
    }
}

fn webui_state(chromium: Option<&Dir>) -> io::Result<WebUIState> {
    let Some(chromium) = chromium else {
        return Ok(WebUIState::Missing);
    };
    match chromium.read(names::LOCAL_STATE, LOCAL_STATE_LIMIT)? {
        Fetched::Missing => Ok(WebUIState::Missing),
        Fetched::Data(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(state)) => Ok(WebUIState::Parsed(bytes.to_vec(), state)),
            _ => Ok(WebUIState::Malformed(bytes.to_vec())),
        },
        Fetched::TooLarge => Ok(WebUIState::Oversized),
        _ => Err(fsafe::unsafe_path(names::LOCAL_STATE.into())),
    }
}

pub fn merged_local_state(existing: Option<&Map<String, Value>>, os_crypt: &Value) -> Vec<u8> {
    let mut state = existing.cloned().unwrap_or_default();
    state.insert("os_crypt".into(), os_crypt.clone());
    serde_json::to_vec(&Value::Object(state)).unwrap_or_default()
}

fn kept_folder(run: &str) -> String {
    format!("{}-{run}", names::CHROMIUM_FOLDER)
}

fn kept_folder_name(name: &str) -> bool {
    name.strip_prefix(names::CHROMIUM_FOLDER)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|run| valid_run(&json!({ "run": run })))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Replace,
    Restored,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Replace => "replace",
            Mode::Restored => "restored",
        }
    }
}

#[derive(Clone, Debug)]
struct Progress {
    mode: Mode,
    kept: String,
    profiles: Vec<(String, String)>,
    staged: bool,
    local_state: bool,
    installed: BTreeSet<String>,
}

impl Progress {
    fn to_json(&self) -> Value {
        json!({
            "version": REPORT_VERSION,
            "mode": self.mode.as_str(),
            "kept": self.kept,
            "profiles": self.profiles.iter().map(|(from, to)| json!([from, to])).collect::<Vec<_>>(),
            "staged": self.staged,
            "local_state": self.local_state,
            "installed": self.installed.iter().collect::<Vec<_>>(),
        })
    }

    fn parse(value: &Value) -> Option<Progress> {
        if value.get("version")?.as_u64()? != REPORT_VERSION {
            return None;
        }
        let mode = match value.get("mode")?.as_str()? {
            "replace" => Mode::Replace,
            "restored" => Mode::Restored,
            _ => return None,
        };
        let kept = value.get("kept")?.as_str()?;
        if !kept_folder_name(kept) {
            return None;
        }
        let mut profiles = Vec::new();
        for pair in value.get("profiles")?.as_array()? {
            let pair = pair.as_array()?;
            let (from, to) = (pair.first()?.as_str()?, pair.get(1)?.as_str()?);
            if pair.len() != 2 || names::webui_profile_folder(from).as_deref() != Some(to) {
                return None;
            }
            profiles.push((from.to_string(), to.to_string()));
        }
        let targets: BTreeSet<&str> = profiles.iter().map(|(_, to)| to.as_str()).collect();
        if targets.len() != profiles.len() {
            return None;
        }
        let mut installed = BTreeSet::new();
        for name in value.get("installed")?.as_array()? {
            let name = name.as_str()?;
            if !targets.contains(name) {
                return None;
            }
            installed.insert(name.to_string());
        }
        Some(Progress {
            mode,
            kept: kept.to_string(),
            profiles,
            staged: value.get("staged")?.as_bool()?,
            local_state: value.get("local_state")?.as_bool()?,
            installed,
        })
    }
}

enum Step {
    Nothing,
    Busy,
    Done,
}

type StepResult<T> = Result<T, (ChromiumStage, io::Error)>;

struct Job {
    from: Arc<Dir>,
    to: Arc<Dir>,
    name: String,
    len: u64,
}

enum Copied {
    Bytes(u64),
    Vanished,
    Link,
    Invalid,
    Unreadable,
}

fn modified(meta: &std::fs::Metadata) -> Option<SystemTime> {
    meta.modified().ok()
}

fn copy_one(job: &Job, buffer: &mut [u8]) -> io::Result<Copied> {
    let (mut source, meta) = match job.from.open_source(&job.name) {
        Ok(Opened::File(file, meta)) => (file, meta),
        Ok(Opened::Missing) => return Ok(Copied::Vanished),
        Ok(Opened::Link) => return Ok(Copied::Link),
        Ok(Opened::NotRegular | Opened::HardLinked) => return Ok(Copied::Invalid),
        Err(_) => return Ok(Copied::Unreadable),
    };
    let mut target = job.to.replace_file(&job.name)?;
    let mut copied = 0u64;
    loop {
        let read = match source.read(buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                drop(target);
                let _ = job.to.remove_file(&job.name);
                return Ok(Copied::Unreadable);
            }
        };
        target.write_all(&buffer[..read])?;
        copied += read as u64;
    }
    if let Some(time) = modified(&meta) {
        target.set_modified(time)?;
    }
    target.sync_all()?;
    Ok(Copied::Bytes(copied))
}

const MOVE_TRIES: u32 = 20;

fn held_by_another_process(error: &io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

fn moved(mut attempt: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut tries = 1;
    loop {
        match attempt() {
            Err(error) if tries < MOVE_TRIES && held_by_another_process(&error) => {
                std::thread::sleep(std::time::Duration::from_millis(50 * u64::from(tries)));
                tries += 1;
            }
            other => return other,
        }
    }
}

fn out_of_space(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::StorageFull
        || matches!(error.raw_os_error(), Some(code) if cfg!(windows) && (code == 39 || code == 112))
}

struct Run<'a> {
    webui: &'a Root,
    sealer: &'a dyn Sealer,
    faults: &'a Faults,
    kept_name: String,
    counts: ChromiumCounts,
    commits: usize,
    kept: Option<Dir>,
}

impl Run<'_> {
    fn checkpoint(&mut self) -> io::Result<()> {
        self.commits += 1;
        if self.faults.fail_at_commit == Some(self.commits) {
            return Err(io::Error::other("stopped before a rename"));
        }
        Ok(())
    }

    fn write(&mut self, dir: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
        let staged = dir.stage(bytes)?;
        if let Err(error) = self.checkpoint() {
            dir.abandon(staged);
            return Err(error);
        }
        dir.commit(staged, name)
    }

    fn save_progress(&mut self, progress: &Progress) -> StepResult<()> {
        let bytes = serde_json::to_vec_pretty(&progress.to_json())
            .map_err(|e| (ChromiumStage::Progress, io::Error::other(e)))?;
        let root = self.webui.dir();
        self.write(root, names::CHROMIUM_PROGRESS_NAME, &bytes)
            .map_err(|e| (ChromiumStage::Progress, e))
    }

    fn read_progress(&self) -> Option<Progress> {
        match self
            .webui
            .dir()
            .read(names::CHROMIUM_PROGRESS_NAME, PROGRESS_LIMIT)
            .ok()?
        {
            Fetched::Data(bytes) => serde_json::from_slice::<Value>(&bytes)
                .ok()
                .as_ref()
                .and_then(Progress::parse),
            _ => None,
        }
    }

    fn kept(&mut self) -> io::Result<&Dir> {
        if self.kept.is_none() {
            let folder = self.kept_name.clone();
            let kept = self
                .webui
                .folder(&[names::KEPT_FOLDER, &folder], true)?
                .ok_or_else(|| fsafe::unsafe_path(folder.into()))?;
            self.kept = Some(kept);
        }
        Ok(self.kept.as_ref().expect("kept folder was just made"))
    }

    fn chromium(&self, create: bool) -> io::Result<Option<Dir>> {
        self.webui.folder(&[names::CHROMIUM_FOLDER], create)
    }

    fn staging(&self, create: bool) -> io::Result<Option<Dir>> {
        self.webui.folder(&[names::CHROMIUM_STAGING_FOLDER], create)
    }

    fn sweep(&mut self) -> io::Result<()> {
        self.counts.partials_swept += self.webui.dir().sweep_partials()? as u64;
        if let Some(chromium) = self.chromium(false)? {
            self.counts.partials_swept += chromium.sweep_partials()? as u64;
        }
        Ok(())
    }

    fn plan(&mut self, source: &Dir) -> io::Result<Vec<(String, String)>> {
        let mut planned = BTreeMap::new();
        let mut names_in_source = source.list()?;
        names_in_source.sort_by_key(|name| name != names::RNW_DEFAULT_PROFILE);
        for name in names_in_source {
            let Some(target) = names::webui_profile_folder(&name) else {
                continue;
            };
            match source.entry(&name)? {
                Entry::Directory => {}
                Entry::Link => {
                    self.counts.skipped_links += 1;
                    continue;
                }
                Entry::Missing => continue,
                Entry::File | Entry::Other => {
                    self.counts.skipped_invalid += 1;
                    continue;
                }
            }
            if planned.contains_key(&names::folded(&target)) {
                self.counts.skipped_clash += 1;
                continue;
            }
            planned.insert(names::folded(&target), (name, target));
        }
        let mut profiles: Vec<(String, String)> = planned.into_values().collect();
        profiles.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(profiles)
    }

    fn scan(
        &mut self,
        source: Arc<Dir>,
        target: Arc<Dir>,
        parents: &mut Vec<String>,
        jobs: &mut Vec<Job>,
    ) -> io::Result<()> {
        for name in source.list()? {
            if names::profile_transient(parents, &name) {
                continue;
            }
            match source.entry(&name)? {
                Entry::Missing => {}
                Entry::Link => self.counts.skipped_links += 1,
                Entry::Other => self.counts.skipped_invalid += 1,
                Entry::Directory if parents.len() + 1 >= DEPTH_LIMIT => self.counts.skipped_invalid += 1,
                Entry::Directory => {
                    let Some(inner) = source.child(&name, false)? else {
                        continue;
                    };
                    let made = target
                        .child(&name, true)?
                        .ok_or_else(|| fsafe::unsafe_path(name.clone().into()))?;
                    parents.push(name);
                    let scanned = self.scan(Arc::new(inner), Arc::new(made), parents, jobs);
                    parents.pop();
                    scanned?;
                }
                Entry::File => {
                    let meta = match source.open_source(&name) {
                        Ok(Opened::File(_, meta)) => meta,
                        Ok(Opened::Missing) => continue,
                        Ok(Opened::Link) => {
                            self.counts.skipped_links += 1;
                            continue;
                        }
                        Ok(Opened::NotRegular | Opened::HardLinked) => {
                            self.counts.skipped_invalid += 1;
                            continue;
                        }
                        Err(_) => {
                            self.counts.skipped_unreadable += 1;
                            continue;
                        }
                    };
                    if let Ok(Opened::File(_, staged)) = target.open_source(&name) {
                        if staged.len() == meta.len()
                            && modified(&staged).is_some()
                            && modified(&staged) == modified(&meta)
                        {
                            self.counts.files += 1;
                            self.counts.files_reused += 1;
                            continue;
                        }
                    }
                    jobs.push(Job {
                        from: Arc::clone(&source),
                        to: Arc::clone(&target),
                        name,
                        len: meta.len(),
                    });
                }
            }
        }
        Ok(())
    }

    fn copy(&mut self, jobs: &[Job]) -> io::Result<()> {
        let workers = if self.faults.fail_at_file.is_some() {
            1
        } else {
            COPY_WORKERS
        };
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let stop = AtomicBool::new(false);
        let bytes = AtomicU64::new(0);
        let tallies: [AtomicU64; 4] = Default::default();
        let failure: Mutex<Option<io::Error>> = Mutex::new(None);
        let fail_at_file = self.faults.fail_at_file;
        let fail = |error: io::Error| {
            stop.store(true, Ordering::SeqCst);
            failure.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(error);
        };
        std::thread::scope(|scope| {
            for _ in 0..workers.min(jobs.len().max(1)) {
                scope.spawn(|| {
                    let mut buffer = vec![0u8; COPY_BUFFER];
                    while !stop.load(Ordering::SeqCst) {
                        let index = next.fetch_add(1, Ordering::SeqCst);
                        let Some(job) = jobs.get(index) else {
                            break;
                        };
                        if fail_at_file.is_some_and(|limit| done.load(Ordering::SeqCst) >= limit) {
                            fail(io::Error::other("stopped before a file"));
                            break;
                        }
                        match copy_one(job, &mut buffer) {
                            Ok(Copied::Bytes(copied)) => {
                                bytes.fetch_add(copied, Ordering::SeqCst);
                                tallies[0].fetch_add(1, Ordering::SeqCst);
                            }
                            Ok(Copied::Vanished) => {}
                            Ok(Copied::Link) => {
                                tallies[1].fetch_add(1, Ordering::SeqCst);
                            }
                            Ok(Copied::Invalid) => {
                                tallies[2].fetch_add(1, Ordering::SeqCst);
                            }
                            Ok(Copied::Unreadable) => {
                                tallies[3].fetch_add(1, Ordering::SeqCst);
                            }
                            Err(error) => fail(error),
                        }
                        done.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        self.counts.files += tallies[0].load(Ordering::SeqCst);
        self.counts.skipped_links += tallies[1].load(Ordering::SeqCst);
        self.counts.skipped_invalid += tallies[2].load(Ordering::SeqCst);
        self.counts.skipped_unreadable += tallies[3].load(Ordering::SeqCst);
        self.counts.megabytes += bytes.load(Ordering::SeqCst).div_ceil(MEBIBYTE);
        match failure.into_inner().unwrap_or_else(|e| e.into_inner()) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn stage_profiles(&mut self, source: &Dir, profiles: &[(String, String)]) -> StepResult<()> {
        let mut jobs = Vec::new();
        {
            let staging = self
                .staging(true)
                .and_then(|staging| staging.ok_or_else(|| fsafe::unsafe_path(names::CHROMIUM_STAGING_FOLDER.into())))
                .map_err(|e| (ChromiumStage::Scan, e))?;
            for (from, to) in profiles {
                let scanned = (|| -> io::Result<()> {
                    let inner = source
                        .child(from, false)?
                        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the profile folder went away"))?;
                    let made = staging.child(to, true)?.ok_or_else(|| fsafe::unsafe_path(to.into()))?;
                    self.scan(Arc::new(inner), Arc::new(made), &mut Vec::new(), &mut jobs)
                })();
                scanned.map_err(|e| (ChromiumStage::Scan, e))?;
            }
        }
        let needed: u64 = jobs.iter().map(|job| job.len).sum();
        let free = match self.faults.free_space {
            Some(free) => free,
            None => fsafe::free_space(&self.webui.resolved).map_err(|e| (ChromiumStage::Space, e))?,
        };
        if free < needed.saturating_add(SPACE_MARGIN) {
            return Err((
                ChromiumStage::Space,
                io::Error::new(io::ErrorKind::StorageFull, "not enough free space to copy the profiles"),
            ));
        }
        let copied = self.copy(&jobs);
        drop(jobs);
        copied.map_err(|e| (ChromiumStage::Staging, e))
    }

    fn carry_key(&mut self, rnw: &RnwKey, webui: &WebUIState) -> StepResult<()> {
        let RnwKey::Ready {
            os_crypt,
            encrypted_key,
        } = rnw
        else {
            return Ok(());
        };
        if webui.encrypted_key() == Some(encrypted_key.as_str()) {
            return Ok(());
        }
        let chromium = self
            .chromium(true)
            .and_then(|c| c.ok_or_else(|| fsafe::unsafe_path(names::CHROMIUM_FOLDER.into())))
            .map_err(|e| (ChromiumStage::LocalState, e))?;
        let (existing, previous) = match webui {
            WebUIState::Missing | WebUIState::Oversized => (None, None),
            WebUIState::Malformed(bytes) => (None, Some(bytes.as_slice())),
            WebUIState::Parsed(bytes, state) => (Some(state), Some(bytes.as_slice())),
        };
        if matches!(webui, WebUIState::Oversized) {
            let kept = self.kept().map_err(|e| (ChromiumStage::LocalState, e))?;
            moved(|| chromium.move_to(names::LOCAL_STATE, kept, names::LOCAL_STATE))
                .map_err(|e| (ChromiumStage::LocalState, e))?;
            self.counts.local_state_kept = 1;
        }
        if let Some(previous) = previous {
            let previous = previous.to_vec();
            let kept = self.kept().map_err(|e| (ChromiumStage::LocalState, e))?;
            kept.write(names::LOCAL_STATE, &previous)
                .map_err(|e| (ChromiumStage::LocalState, e))?;
            self.counts.local_state_kept = 1;
        }
        let bytes = merged_local_state(existing, os_crypt);
        self.write(&chromium, names::LOCAL_STATE, &bytes)
            .map_err(|e| (ChromiumStage::LocalState, e))?;
        self.counts.key_carried = 1;
        Ok(())
    }

    fn install(&mut self, to: &str) -> StepResult<bool> {
        let swap = |e| (ChromiumStage::Swap, e);
        let staging = self.staging(false).map_err(swap)?;
        let staged = match &staging {
            Some(staging) => staging.entry(to).map_err(swap)? == Entry::Directory,
            None => false,
        };
        let chromium = self
            .chromium(true)
            .and_then(|c| c.ok_or_else(|| fsafe::unsafe_path(names::CHROMIUM_FOLDER.into())))
            .map_err(swap)?;
        let present = chromium.entry(to).map_err(swap)?;
        let Some(staging) = staging.filter(|_| staged) else {
            return if present == Entry::Directory {
                Ok(false)
            } else {
                Err(swap(io::Error::new(
                    io::ErrorKind::NotFound,
                    "a staged profile went missing",
                )))
            };
        };
        if present != Entry::Missing {
            self.checkpoint().map_err(swap)?;
            let kept = self.kept().map_err(swap)?;
            moved(|| chromium.move_to(to, kept, to)).map_err(swap)?;
            self.counts.profiles_replaced += 1;
        }
        self.checkpoint().map_err(swap)?;
        moved(|| staging.move_to(to, &chromium, to)).map_err(swap)?;
        Ok(true)
    }

    fn steps(&mut self, rnw: Option<&Root>) -> StepResult<Step> {
        self.sweep().map_err(|e| (ChromiumStage::Lock, e))?;
        let Some(rnw) = rnw else {
            return Ok(Step::Nothing);
        };
        let source = rnw.dir();
        let in_use = |e| (ChromiumStage::InUse, e);
        if source.held_open(names::CHROMIUM_LOCK_FILE).map_err(in_use)? {
            return Ok(Step::Busy);
        }
        let chromium = self.chromium(false).map_err(|e| (ChromiumStage::Layout, e))?;
        if let Some(chromium) = &chromium {
            if chromium.held_open(names::CHROMIUM_LOCK_FILE).map_err(in_use)? {
                return Ok(Step::Busy);
            }
        }
        let local = |e| (ChromiumStage::LocalState, e);
        let rnw_key = rnw_key(source, self.sealer).map_err(local)?;
        let webui = webui_state(chromium.as_ref()).map_err(local)?;
        match rnw_key {
            RnwKey::Missing => self.counts.key_missing = 1,
            RnwKey::Unreadable => self.counts.key_unreadable = 1,
            RnwKey::Ready { .. } => {}
        }
        if matches!(webui, WebUIState::Malformed(_) | WebUIState::Oversized) {
            self.counts.local_state_malformed = 1;
        }

        let mut progress = match self.read_progress().filter(|progress| progress.staged) {
            Some(progress) => progress,
            None => {
                let planned = self.plan(source).map_err(|e| (ChromiumStage::Scan, e))?;
                if planned.is_empty() {
                    return Ok(Step::Nothing);
                }
                let shared = rnw_key.encrypted_key().is_some() && rnw_key.encrypted_key() == webui.encrypted_key();
                let mode = if shared { Mode::Restored } else { Mode::Replace };
                let mut profiles = Vec::new();
                for (from, to) in planned {
                    let present = match &chromium {
                        Some(chromium) => chromium.entry(&to).map_err(|e| (ChromiumStage::Scan, e))? != Entry::Missing,
                        None => false,
                    };
                    if mode == Mode::Restored && present {
                        continue;
                    }
                    profiles.push((from, to));
                }
                let progress = Progress {
                    mode,
                    kept: self.kept_name.clone(),
                    profiles,
                    staged: false,
                    local_state: false,
                    installed: BTreeSet::new(),
                };
                self.stage_profiles(source, &progress.profiles)?;
                let progress = Progress {
                    staged: true,
                    ..progress
                };
                self.save_progress(&progress)?;
                progress
            }
        };
        self.counts.key_shared = u64::from(progress.mode == Mode::Restored);
        if self.kept_name != progress.kept {
            self.kept_name = progress.kept.clone();
            self.kept = None;
        }

        if !progress.local_state {
            if progress.mode == Mode::Replace {
                self.carry_key(&rnw_key, &webui)?;
            }
            progress.local_state = true;
            self.save_progress(&progress)?;
        }
        let targets: Vec<String> = progress.profiles.iter().map(|(_, to)| to.clone()).collect();
        for to in &targets {
            if progress.installed.contains(to) {
                continue;
            }
            self.install(to)?;
            progress.installed.insert(to.clone());
            self.save_progress(&progress)?;
        }
        self.counts.profiles = progress.installed.len() as u64;
        if let Some(chromium) = self.chromium(false).map_err(|e| (ChromiumStage::Swap, e))? {
            for name in chromium.list().map_err(|e| (ChromiumStage::Swap, e))? {
                if names::webui_profile_name(&name)
                    && !targets.iter().any(|to| to.eq_ignore_ascii_case(&name))
                    && chromium.entry(&name).map_err(|e| (ChromiumStage::Swap, e))? == Entry::Directory
                {
                    self.counts.webui_profiles_left += 1;
                }
            }
        }
        let _ = self.webui.dir().remove_tree(names::CHROMIUM_STAGING_FOLDER);
        Ok(Step::Done)
    }

    fn clear_staging(&mut self) {
        let _ = self.webui.dir().remove_tree(names::CHROMIUM_STAGING_FOLDER);
        let _ = self.webui.dir().remove_file(names::CHROMIUM_PROGRESS_NAME);
        self.counts.staging_cleared = 1;
    }
}

fn report_bytes(report: &ChromiumReport) -> io::Result<Vec<u8>> {
    serde_json::to_vec_pretty(&report.to_json()).map_err(io::Error::other)
}

pub fn migrate_chromium(layout: &Layout, sealer: &dyn Sealer, faults: &Faults) -> ChromiumReport {
    let started = Instant::now();
    let mut report = ChromiumReport {
        outcome: Outcome::Failed,
        failed_stage: None,
        counts: ChromiumCounts::default(),
        duration_ms: 0,
        attempt: 1,
        prior_failed_stage: None,
        run: fsafe::run_id(),
    };
    let finish = |mut report: ChromiumReport| {
        report.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        report
    };
    let refuse = |mut report: ChromiumReport, stage: ChromiumStage| {
        report.outcome = Outcome::Refused;
        report.failed_stage = Some(stage);
        finish(report)
    };

    if check_layout(layout).is_err() {
        return refuse(report, ChromiumStage::Layout);
    }
    if matches!(fsafe::entry(&layout.rnw_chromium), Ok(Entry::Missing)) {
        report.outcome = Outcome::NothingToMigrate;
        return finish(report);
    }
    let webui = match Root::open_or_create(&layout.webui_data) {
        Ok(webui) => webui,
        Err(error) if fsafe::is_unsafe(&error) => return refuse(report, ChromiumStage::Layout),
        Err(_) => {
            report.failed_stage = Some(ChromiumStage::Layout);
            return finish(report);
        }
    };
    let Ok(rnw) = source_root(&layout.rnw_chromium) else {
        return refuse(report, ChromiumStage::Layout);
    };
    if rnw
        .as_ref()
        .is_some_and(|root| overlapping(&root.resolved, &webui.resolved))
    {
        return refuse(report, ChromiumStage::Layout);
    }

    let lock = match webui.dir().open_lock(names::LOCK_NAME) {
        Ok(lock) => lock,
        Err(error) if fsafe::is_unsafe(&error) => return refuse(report, ChromiumStage::Lock),
        Err(_) => {
            report.failed_stage = Some(ChromiumStage::Lock);
            return finish(report);
        }
    };
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            report.outcome = Outcome::Busy;
            report.failed_stage = Some(ChromiumStage::Lock);
            return finish(report);
        }
        Err(std::fs::TryLockError::Error(_)) => {
            report.failed_stage = Some(ChromiumStage::Lock);
            return finish(report);
        }
    }

    if !matches!(
        webui.dir().entry(names::CHROMIUM_MARKER_NAME),
        Ok(Entry::Missing | Entry::File)
    ) {
        return refuse(report, ChromiumStage::Marker);
    }
    if read_report(&webui, names::CHROMIUM_MARKER_NAME)
        .filter(valid_chromium_marker)
        .is_some()
    {
        report.outcome = Outcome::AlreadyMigrated;
        return finish(report);
    }
    let previous = match webui.dir().read(names::CHROMIUM_ATTEMPT_NAME, REPORT_LIMIT) {
        Ok(Fetched::Data(bytes)) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(valid_chromium_attempt),
        _ => None,
    };
    report.attempt = previous
        .as_ref()
        .and_then(|previous| previous.get("attempt").and_then(Value::as_u64))
        .map_or(1, |previous| previous.saturating_add(1).min(ATTEMPT_CAP));
    report.prior_failed_stage = previous.as_ref().and_then(prior_failed_stage);

    let mut run = Run {
        webui: &webui,
        sealer,
        faults,
        kept_name: kept_folder(&report.run),
        counts: ChromiumCounts::default(),
        commits: 0,
        kept: None,
    };
    let stepped = run.steps(rnw.as_ref());
    if let Err((ChromiumStage::Space | ChromiumStage::Staging, error)) = &stepped {
        if out_of_space(error) {
            run.clear_staging();
        }
    }
    report.counts = run.counts.clone();
    let write_attempt = |report: &mut ChromiumReport| {
        if report_bytes(report)
            .and_then(|bytes| webui.dir().write(names::CHROMIUM_ATTEMPT_NAME, &bytes))
            .is_err()
        {
            report.failed_stage = Some(ChromiumStage::Report);
        }
    };
    match stepped {
        Err((stage, _error)) => {
            report.outcome = Outcome::Failed;
            report.failed_stage = Some(stage);
            let mut report = finish(report);
            write_attempt(&mut report);
            return report;
        }
        Ok(Step::Busy) => {
            report.outcome = Outcome::Busy;
            report.failed_stage = Some(ChromiumStage::InUse);
            let mut report = finish(report);
            write_attempt(&mut report);
            return report;
        }
        Ok(Step::Nothing) => report.outcome = Outcome::NothingToMigrate,
        Ok(Step::Done) => {
            report.outcome = if report.counts.skipped() > 0 {
                Outcome::MigratedWithSkips
            } else {
                Outcome::Migrated
            }
        }
    }
    let mut report = finish(report);
    let root = webui.dir();
    let commits = [
        (names::CHROMIUM_ATTEMPT_NAME, ChromiumStage::Report),
        (names::CHROMIUM_MARKER_NAME, ChromiumStage::Marker),
    ];
    for (name, stage) in commits {
        let written = report_bytes(&report).and_then(|bytes| run.write(root, name, &bytes));
        if written.is_err() {
            report.outcome = Outcome::Failed;
            report.failed_stage = Some(stage);
            write_attempt(&mut report);
            return report;
        }
    }
    let _ = root.remove_file(names::CHROMIUM_PROGRESS_NAME);
    drop(lock);
    report
}
