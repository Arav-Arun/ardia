mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ardia_shell_migration::chromium::{
    base64_decode, chromium_key_opens, merged_local_state, read_chromium_attempt, read_chromium_marker,
    valid_chromium_marker,
};
use ardia_shell_migration::{migrate_chromium, names, ChromiumReport, Faults, Layout, Outcome, Sealer};
use common::*;
use serde_json::{json, Value};

const RNW_KEY: [u8; 32] = [7; 32];
const WEBUI_KEY: [u8; 32] = [9; 32];

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let word = chunk
            .iter()
            .enumerate()
            .fold(0u32, |w, (i, b)| w | (u32::from(*b) << (16 - 8 * i)));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(ALPHABET[(word >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn chromium_key(sealer: &FakeDpapi, key: &[u8]) -> String {
    let mut wrapped = b"DPAPI".to_vec();
    wrapped.extend(sealer.seal(key, "").unwrap());
    base64(&wrapped)
}

fn run(layout: &Layout, sealer: &FakeDpapi) -> ChromiumReport {
    migrate_chromium(layout, sealer, &Faults::default())
}

fn webui_chromium(layout: &Layout) -> PathBuf {
    layout.webui_data.join(names::CHROMIUM_FOLDER)
}

fn os_crypt(sealer: &FakeDpapi, key: &[u8]) -> Value {
    json!({ "encrypted_key": chromium_key(sealer, key), "audit_enabled": true })
}

fn seed_rnw(layout: &Layout, sealer: &FakeDpapi) -> Value {
    let user_data = &layout.rnw_chromium;
    let crypt = os_crypt(sealer, &RNW_KEY);
    let state = json!({ "os_crypt": crypt, "profile": { "info_cache": { "Default": { "name": "Me" } } } });
    write(
        &user_data.join(names::LOCAL_STATE),
        &serde_json::to_vec(&state).unwrap(),
    );
    let default = user_data.join("Default");
    for (path, bytes) in [
        ("History", b"rnw history".as_slice()),
        ("Network/Cookies", b"v10 rnw cookies"),
        ("Login Data", b"v10 rnw logins"),
        ("Preferences", b"{\"extensions\":{}}"),
        ("Bookmarks", b"{}"),
        ("Extensions/abcdef/1.0_0/manifest.json", b"{\"name\":\"ext\"}"),
        ("Local Extension Settings/abcdef/000003.log", b"ext state"),
        ("Local Extension Settings/abcdef/LOCK", b""),
        ("IndexedDB/https_site_0.indexeddb.leveldb/000005.ldb", b"idb"),
        ("Service Worker/Database/000001.log", b"sw db"),
        ("Service Worker/CacheStorage/abc/index", b"sw cache"),
        ("Cache/Cache_Data/data_0", b"http cache"),
        ("Code Cache/js/index", b"code cache"),
        ("GPUCache/data_1", b"gpu"),
        ("DawnGraphiteCache/data_0", b"dawn"),
        ("DawnWebGPUCache/data_0", b"dawn"),
        ("GrShaderCache/data_0", b"shader"),
        ("ShaderCache/data_0", b"shader"),
        ("Sessions/Session_1", b"session"),
        ("Sessions_Encrypted/Session_1", b"session"),
    ] {
        write(&default.join(path), bytes);
    }
    write(&user_data.join("Ardia p-work/History"), b"work history");
    write(&user_data.join("Ardia p-work/Network/Cookies"), b"v10 work cookies");
    write(&user_data.join("System Profile/Preferences"), b"system");
    write(&user_data.join("Guest Profile/Preferences"), b"guest");
    write(&user_data.join("Ardia Upper/History"), b"not an Ardia profile name");
    write(&user_data.join("Crashpad/settings.dat"), b"crash");
    write(&user_data.join("First Run"), b"");
    state
}

fn seed_webui_049(layout: &Layout, sealer: &FakeDpapi) -> Vec<u8> {
    let chromium = webui_chromium(layout);
    let state = json!({
        "os_crypt": os_crypt(sealer, &WEBUI_KEY),
        "browser": { "last_redirect_origin": "" },
        "profile": { "info_cache": { "Ardia default": { "name": "default" } } },
    });
    let bytes = serde_json::to_vec(&state).unwrap();
    write(&chromium.join(names::LOCAL_STATE), &bytes);
    write(&chromium.join("Ardia default/History"), b"webui history");
    write(&chromium.join("Ardia default/Network/Cookies"), b"v10 webui cookies");
    write(&chromium.join("Ardia p-new/History"), b"made on 0.2.49");
    write(
        &layout.webui_data.join(names::MARKER_NAME),
        b"{\"outcome\":\"migrated\"}",
    );
    bytes
}

type Snapshot = BTreeMap<String, (Vec<u8>, Option<SystemTime>)>;

fn snapshot(root: &Path) -> Snapshot {
    let mut found = Snapshot::new();
    fn walk(root: &Path, dir: &Path, found: &mut Snapshot) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            let meta = fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if meta.is_dir() {
                found.insert(format!("{relative}/"), (Vec::new(), None));
                walk(root, &path, found);
            } else {
                found.insert(relative, (fs::read(&path).unwrap_or_default(), meta.modified().ok()));
            }
        }
    }
    walk(root, root, &mut found);
    found
}

fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    tree(root)
        .into_iter()
        .filter(|(path, _)| !path.ends_with('/'))
        .collect()
}

fn local_state(layout: &Layout) -> Value {
    serde_json::from_slice(&fs::read(webui_chromium(layout).join(names::LOCAL_STATE)).unwrap()).unwrap()
}

fn kept_folders(layout: &Layout) -> Vec<PathBuf> {
    let kept = layout.webui_data.join(names::KEPT_FOLDER);
    let Ok(entries) = fs::read_dir(kept) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("Chromium-"))
        .collect();
    found.sort();
    found
}

fn kept_files(layout: &Layout) -> BTreeMap<String, Vec<u8>> {
    let mut all = BTreeMap::new();
    for folder in kept_folders(layout) {
        all.extend(files(&folder));
    }
    all
}

fn counts(report: &ChromiumReport) -> BTreeMap<&'static str, u64> {
    report.counts.fields().into_iter().collect()
}

#[test]
fn a_fresh_upgrade_copies_every_profile_without_caches_and_carries_the_key() {
    let scratch = Scratch::new("chromium-fresh");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_state = seed_rnw(&layout, &sealer);
    let before = snapshot(&layout.rnw_data);

    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(report.exit_code(), 0);

    let chromium = webui_chromium(&layout);
    let default = files(&chromium.join("Ardia default"));
    let expected: Vec<&str> = vec![
        "Bookmarks",
        "Extensions/abcdef/1.0_0/manifest.json",
        "History",
        "IndexedDB/https_site_0.indexeddb.leveldb/000005.ldb",
        "Local Extension Settings/abcdef/000003.log",
        "Login Data",
        "Network/Cookies",
        "Preferences",
        "Service Worker/Database/000001.log",
    ];
    assert_eq!(default.keys().map(String::as_str).collect::<Vec<_>>(), expected);
    assert_eq!(default["History"], b"rnw history");
    assert_eq!(default["Network/Cookies"], b"v10 rnw cookies");
    assert_eq!(
        files(&chromium.join("Ardia p-work"))["Network/Cookies"],
        b"v10 work cookies"
    );
    for absent in [
        "Default",
        "System Profile",
        "Guest Profile",
        "Ardia Upper",
        "Crashpad",
        "First Run",
    ] {
        assert!(!chromium.join(absent).exists(), "{absent} was copied");
    }
    assert_eq!(local_state(&layout), json!({ "os_crypt": rnw_state["os_crypt"] }));
    assert!(chromium_key_opens(
        &sealer,
        local_state(&layout)["os_crypt"]["encrypted_key"].as_str().unwrap()
    ));

    let counted = counts(&report);
    assert_eq!(counted["profiles"], 2);
    assert_eq!(counted["profiles_replaced"], 0);
    assert_eq!(counted["key_carried"], 1);
    assert_eq!(counted["files"], 11);
    assert_eq!(counted["local_state_kept"], 0);

    assert_eq!(
        snapshot(&layout.rnw_data),
        before,
        "the React Native profile is only read"
    );
    assert!(read_chromium_marker(&layout.webui_data).is_some());
    assert!(!layout.webui_data.join(names::CHROMIUM_PROGRESS_NAME).exists());
    assert!(!layout.webui_data.join(names::CHROMIUM_STAGING_FOLDER).exists());
    assert!(kept_folders(&layout).is_empty());
    let attempt = read_chromium_attempt(&layout.webui_data).unwrap();
    assert_eq!(attempt["step"], "chromium");
    assert_eq!(attempt["outcome"], "migrated");
}

#[test]
fn a_second_run_answers_already_migrated_and_touches_nothing() {
    let scratch = Scratch::new("chromium-again");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
    write(&webui_chromium(&layout).join("Ardia default/History"), b"browsed since");
    let after_first = snapshot(&layout.webui_data);

    let again = run(&layout, &sealer);
    assert_eq!(again.outcome, Outcome::AlreadyMigrated);
    assert_eq!(again.exit_code(), 0);
    assert_eq!(snapshot(&layout.webui_data), after_first);
}

#[test]
fn a_user_who_already_ran_0_2_49_gets_the_old_profiles_back_and_keeps_the_new_ones_aside() {
    let scratch = Scratch::new("chromium-049");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_state = seed_rnw(&layout, &sealer);
    let webui_state = seed_webui_049(&layout, &sealer);
    let before = snapshot(&layout.rnw_data);

    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    let chromium = webui_chromium(&layout);
    assert_eq!(
        fs::read(chromium.join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
    assert_eq!(
        fs::read(chromium.join("Ardia default/Network/Cookies")).unwrap(),
        b"v10 rnw cookies"
    );
    assert!(!chromium.join("Ardia default/Cache").exists());
    assert_eq!(
        fs::read(chromium.join("Ardia p-work/History")).unwrap(),
        b"work history"
    );
    assert_eq!(
        fs::read(chromium.join("Ardia p-new/History")).unwrap(),
        b"made on 0.2.49"
    );

    let state = local_state(&layout);
    assert_eq!(state["os_crypt"], rnw_state["os_crypt"]);
    assert_eq!(state["browser"], json!({ "last_redirect_origin": "" }));
    assert_eq!(state["profile"]["info_cache"]["Ardia default"]["name"], "default");

    let kept = kept_files(&layout);
    assert_eq!(kept["Ardia default/History"], b"webui history");
    assert_eq!(kept["Ardia default/Network/Cookies"], b"v10 webui cookies");
    assert_eq!(kept[names::LOCAL_STATE], webui_state);
    assert_eq!(kept_folders(&layout).len(), 1);

    let counted = counts(&report);
    assert_eq!(counted["profiles"], 2);
    assert_eq!(counted["profiles_replaced"], 1);
    assert_eq!(counted["webui_profiles_left"], 1);
    assert_eq!(counted["local_state_kept"], 1);
    assert_eq!(counted["key_carried"], 1);
    assert_eq!(counted["key_shared"], 0);
    assert_eq!(snapshot(&layout.rnw_data), before);
    assert_eq!(
        fs::read(layout.webui_data.join(names::MARKER_NAME)).unwrap(),
        b"{\"outcome\":\"migrated\"}",
        "the documents step keeps its own marker"
    );
}

#[test]
fn a_profile_restored_by_hand_is_left_alone_and_only_missing_profiles_are_copied() {
    let scratch = Scratch::new("chromium-manual");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_state = seed_rnw(&layout, &sealer);
    let chromium = webui_chromium(&layout);
    let restored = serde_json::to_vec(&json!({ "os_crypt": rnw_state["os_crypt"], "browser": {} })).unwrap();
    write(&chromium.join(names::LOCAL_STATE), &restored);
    write(
        &chromium.join("Ardia default/History"),
        b"restored by hand, then browsed",
    );

    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated, "{}", report.to_json());
    assert_eq!(
        fs::read(chromium.join("Ardia default/History")).unwrap(),
        b"restored by hand, then browsed"
    );
    assert_eq!(
        fs::read(chromium.join("Ardia p-work/History")).unwrap(),
        b"work history"
    );
    assert_eq!(fs::read(chromium.join(names::LOCAL_STATE)).unwrap(), restored);
    assert!(kept_folders(&layout).is_empty());
    let counted = counts(&report);
    assert_eq!(counted["key_shared"], 1);
    assert_eq!(counted["key_carried"], 0);
    assert_eq!(counted["profiles"], 1);
    assert_eq!(counted["webui_profiles_left"], 1);
}

fn final_state(layout: &Layout, keys: &[(&Value, &str)]) -> (BTreeMap<String, Vec<u8>>, BTreeMap<String, Vec<u8>>) {
    let named = |files: BTreeMap<String, Vec<u8>>| -> BTreeMap<String, Vec<u8>> {
        files
            .into_iter()
            .map(|(path, bytes)| {
                let mut text = String::from_utf8_lossy(&bytes).into_owned();
                for (key, name) in keys {
                    text = text.replace(key.as_str().unwrap(), name);
                }
                (path, text.into_bytes())
            })
            .collect()
    };
    (named(files(&webui_chromium(layout))), named(kept_files(layout)))
}

fn seed_both(layout: &Layout, sealer: &FakeDpapi) -> (Value, Value) {
    let rnw = seed_rnw(layout, sealer)["os_crypt"]["encrypted_key"].clone();
    let webui: Value = serde_json::from_slice(&seed_webui_049(layout, sealer)).unwrap();
    (rnw, webui["os_crypt"]["encrypted_key"].clone())
}

#[test]
fn stopping_before_any_rename_and_running_again_ends_where_one_run_does() {
    let reference = {
        let scratch = Scratch::new("chromium-reference");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        let (rnw, webui) = seed_both(&layout, &sealer);
        assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
        final_state(&layout, &[(&rnw, "RNW-KEY"), (&webui, "WEBUI-KEY")])
    };
    let mut stopped = 0;
    for fail_at in 1.. {
        let scratch = Scratch::new("chromium-resume");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        let (rnw, webui) = seed_both(&layout, &sealer);
        let before = snapshot(&layout.rnw_data);
        let faults = Faults {
            fail_at_commit: Some(fail_at),
            ..Faults::default()
        };
        let first = migrate_chromium(&layout, &sealer, &faults);
        if first.outcome != Outcome::Failed {
            assert_eq!(first.outcome, Outcome::Migrated);
            break;
        }
        stopped += 1;
        assert_eq!(first.exit_code(), 1);
        assert!(read_chromium_marker(&layout.webui_data).is_none());
        let mut everywhere = files(&layout.webui_data);
        everywhere.extend(kept_files(&layout));
        assert!(
            everywhere.values().any(|bytes| bytes == b"webui history"),
            "0.2.49's history is somewhere after stopping at {fail_at}"
        );
        let second = run(&layout, &sealer);
        assert_eq!(
            second.outcome,
            Outcome::Migrated,
            "resume after {fail_at}: {}",
            second.to_json()
        );
        assert_eq!(second.attempt, 2);
        assert!(second.prior_failed_stage.is_some());
        assert_eq!(
            final_state(&layout, &[(&rnw, "RNW-KEY"), (&webui, "WEBUI-KEY")]),
            reference,
            "resume after stopping at {fail_at}"
        );
        assert_eq!(snapshot(&layout.rnw_data), before);
        assert_eq!(kept_folders(&layout).len(), 1, "one backup after stopping at {fail_at}");
    }
    assert!(stopped >= 6, "the run stops at every rename: {stopped}");
}

#[test]
fn a_copy_stopped_part_way_reuses_the_finished_files() {
    let scratch = Scratch::new("chromium-partway");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let faults = Faults {
        fail_at_file: Some(4),
        ..Faults::default()
    };
    let first = migrate_chromium(&layout, &sealer, &faults);
    assert_eq!(first.outcome, Outcome::Failed);
    assert_eq!(first.failed_stage.map(|s| s.as_str()), Some("staging"));
    assert!(
        !webui_chromium(&layout).exists(),
        "nothing reaches the live profile folder before the copy is whole"
    );
    let second = run(&layout, &sealer);
    assert_eq!(second.outcome, Outcome::Migrated);
    assert_eq!(counts(&second)["files_reused"], 4);
    assert_eq!(counts(&second)["files"], 11);
    assert_eq!(
        fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
}

#[test]
fn a_torn_staged_file_is_copied_again() {
    let scratch = Scratch::new("chromium-torn");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    write(
        &layout
            .webui_data
            .join(names::CHROMIUM_STAGING_FOLDER)
            .join("Ardia default/History"),
        b"rnw hist",
    );
    write(
        &layout
            .webui_data
            .join(names::CHROMIUM_STAGING_FOLDER)
            .join("Ardia default/Login Data"),
        b"v10 rnw XXXXXX",
    );
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated);
    let default = webui_chromium(&layout).join("Ardia default");
    assert_eq!(fs::read(default.join("History")).unwrap(), b"rnw history");
    assert_eq!(fs::read(default.join("Login Data")).unwrap(), b"v10 rnw logins");
}

#[test]
fn a_missing_or_unreadable_rnw_key_still_copies_the_profiles_but_never_writes_a_key() {
    for (label, state) in [
        ("missing", None),
        ("malformed", Some(b"{not json".to_vec())),
        ("no key", Some(b"{\"os_crypt\":{}}".to_vec())),
        (
            "not base64",
            Some(b"{\"os_crypt\":{\"encrypted_key\":\"***\"}}".to_vec()),
        ),
        (
            "not dpapi",
            Some(format!("{{\"os_crypt\":{{\"encrypted_key\":\"{}\"}}}}", base64(b"XXXXXsealed")).into_bytes()),
        ),
    ] {
        let scratch = Scratch::new("chromium-key");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        seed_rnw(&layout, &sealer);
        let rnw_state = layout.rnw_chromium.join(names::LOCAL_STATE);
        match &state {
            None => fs::remove_file(&rnw_state).unwrap(),
            Some(bytes) => fs::write(&rnw_state, bytes).unwrap(),
        }
        let report = run(&layout, &sealer);
        let counted = counts(&report);
        if state.is_none() {
            assert_eq!(report.outcome, Outcome::Migrated, "{label}");
            assert_eq!(counted["key_missing"], 1, "{label}");
        } else {
            assert_eq!(report.outcome, Outcome::MigratedWithSkips, "{label}");
            assert_eq!(counted["key_unreadable"], 1, "{label}");
        }
        assert_eq!(counted["key_carried"], 0, "{label}");
        assert!(!webui_chromium(&layout).join(names::LOCAL_STATE).exists(), "{label}");
        assert_eq!(
            fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
            b"rnw history",
            "{label}"
        );
    }
}

#[test]
fn a_key_sealed_for_another_purpose_does_not_count_as_readable() {
    let scratch = Scratch::new("chromium-wrong-seal");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let mut wrapped = b"DPAPI".to_vec();
    wrapped.extend(sealer.seal(&RNW_KEY, "elsewhere").unwrap());
    let state = json!({ "os_crypt": { "encrypted_key": base64(&wrapped) } });
    fs::write(
        layout.rnw_chromium.join(names::LOCAL_STATE),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(counts(&report)["key_unreadable"], 1);
    let short = json!({ "os_crypt": { "encrypted_key": chromium_key(&sealer, &[1; 16]) } });
    assert!(!chromium_key_opens(
        &sealer,
        short["os_crypt"]["encrypted_key"].as_str().unwrap()
    ));
}

#[test]
fn a_malformed_webui_local_state_is_kept_aside_and_replaced() {
    let scratch = Scratch::new("chromium-bad-webui-state");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_state = seed_rnw(&layout, &sealer);
    write(&webui_chromium(&layout).join(names::LOCAL_STATE), b"[1,2");
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated);
    assert_eq!(local_state(&layout), json!({ "os_crypt": rnw_state["os_crypt"] }));
    assert_eq!(kept_files(&layout)[names::LOCAL_STATE], b"[1,2");
    assert_eq!(counts(&report)["local_state_malformed"], 1);
}

#[cfg(unix)]
#[test]
fn a_running_shell_makes_the_run_wait_without_writing_anything() {
    for side in ["rnw", "webui"] {
        let scratch = Scratch::new("chromium-busy");
        let sealer = FakeDpapi::new();
        let layout = layout(&scratch.0);
        seed_rnw(&layout, &sealer);
        let held = match side {
            "rnw" => layout.rnw_chromium.join(names::CHROMIUM_LOCK_FILE),
            _ => webui_chromium(&layout).join(names::CHROMIUM_LOCK_FILE),
        };
        write(&held, b"");
        let before = snapshot(&layout.webui_data);
        let report = run(&layout, &sealer);
        assert_eq!(report.outcome, Outcome::Busy, "{side}");
        assert_eq!(report.exit_code(), 3);
        assert_eq!(report.failed_stage.map(|s| s.as_str()), Some("in_use"));
        let mut after = snapshot(&layout.webui_data);
        after.remove(names::CHROMIUM_ATTEMPT_NAME);
        after.remove(names::LOCK_NAME);
        let mut before = before;
        before.remove(names::LOCK_NAME);
        assert_eq!(after, before, "{side}");
        assert_eq!(
            read_chromium_attempt(&layout.webui_data).unwrap()["failed_stage"],
            "in_use"
        );
        fs::remove_file(&held).unwrap();
        assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated, "{side}");
    }
}

#[test]
fn too_little_free_space_fails_before_copying_and_clears_the_staging_folder() {
    let scratch = Scratch::new("chromium-space");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    seed_webui_049(&layout, &sealer);
    let before = snapshot(&layout.webui_data);
    let faults = Faults {
        free_space: Some(1024),
        ..Faults::default()
    };
    let report = migrate_chromium(&layout, &sealer, &faults);
    assert_eq!(report.outcome, Outcome::Failed);
    assert_eq!(report.failed_stage.map(|s| s.as_str()), Some("space"));
    assert_eq!(counts(&report)["staging_cleared"], 1);
    let mut after = snapshot(&layout.webui_data);
    after.remove(names::CHROMIUM_ATTEMPT_NAME);
    after.remove(names::LOCK_NAME);
    assert_eq!(after, before, "the 0.2.49 profile is untouched");
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
}

#[test]
fn no_rnw_profile_means_nothing_to_migrate_and_no_chromium_folder() {
    let scratch = Scratch::new("chromium-none");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::NothingToMigrate);
    assert_eq!(report.exit_code(), 0);
    assert!(
        !layout.webui_data.exists(),
        "a machine that never ran the React Native shell gets no WebUI folder from setup"
    );

    let scratch = Scratch::new("chromium-empty");
    let layout = self::layout(&scratch.0);
    write(&layout.rnw_chromium.join("System Profile/Preferences"), b"{}");
    assert_eq!(run(&layout, &sealer).outcome, Outcome::NothingToMigrate);
    assert!(!webui_chromium(&layout).exists());
    let marker = read_chromium_marker(&layout.webui_data).unwrap();
    assert!(valid_chromium_marker(&marker));
    assert_eq!(run(&layout, &sealer).outcome, Outcome::AlreadyMigrated);
}

#[test]
fn a_scratch_data_dir_reads_the_rnw_profile_from_its_chromium_folder() {
    let scratch = Scratch::new("chromium-custom");
    let sealer = FakeDpapi::new();
    let rnw = scratch.0.join("rnw");
    let layout = Layout::custom(rnw.to_str().unwrap(), &scratch.0.join("webui"), true);
    assert_eq!(layout.rnw_chromium, rnw.join("Chromium"));
    seed_rnw(&layout, &sealer);
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
    assert_eq!(
        fs::read(webui_chromium(&layout).join("Ardia default/History")).unwrap(),
        b"rnw history"
    );
}

#[test]
fn the_documents_step_still_leaves_chromium_to_this_one() {
    let scratch = Scratch::new("chromium-documents");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    write(&layout.rnw_data.join("session.json"), b"{}");
    let report = ardia_shell_migration::migrate(&layout, &sealer, &FakeVault::empty(), &Faults::default());
    assert_eq!(report.outcome, Outcome::Migrated);
    assert!(!webui_chromium(&layout).exists());
    assert_eq!(run(&layout, &sealer).outcome, Outcome::Migrated);
}

#[test]
fn a_failed_run_counts_attempts_and_says_where_it_stopped() {
    let scratch = Scratch::new("chromium-attempts");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let tight = Faults {
        free_space: Some(0),
        ..Faults::default()
    };
    assert_eq!(migrate_chromium(&layout, &sealer, &tight).attempt, 1);
    let second = migrate_chromium(&layout, &sealer, &tight);
    assert_eq!(second.attempt, 2);
    assert_eq!(second.prior_failed_stage.map(|s| s.as_str()), Some("space"));
    let third = run(&layout, &sealer);
    assert_eq!(third.outcome, Outcome::Migrated);
    assert_eq!(third.attempt, 3);
    let json = third.to_json();
    assert_eq!(json["prior_failed_stage"], "space");
    assert!(json.get("failed_stage").is_none());
}

#[test]
fn overlapping_folders_are_refused() {
    let scratch = Scratch::new("chromium-overlap");
    let sealer = FakeDpapi::new();
    let base = layout(&scratch.0);
    let inside = Layout {
        webui_data: base.rnw_chromium.join("WebUI"),
        ..base.clone()
    };
    let around = Layout {
        rnw_chromium: base.webui_data.join("Chromium"),
        ..base.clone()
    };
    let relative = Layout {
        rnw_chromium: "User Data".into(),
        ..base.clone()
    };
    for layout in [inside, around, relative] {
        let report = run(&layout, &sealer);
        assert_eq!(report.outcome, Outcome::Refused, "{layout:?}");
        assert_eq!(report.exit_code(), 2);
    }
}

#[cfg(unix)]
#[test]
fn links_in_the_rnw_profile_are_skipped() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new("chromium-links");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    seed_rnw(&layout, &sealer);
    let secret = scratch.0.join("secret");
    write(&secret.join("passwords.txt"), b"elsewhere");
    symlink(&secret, layout.rnw_chromium.join("Default/Linked")).unwrap();
    symlink(
        secret.join("passwords.txt"),
        layout.rnw_chromium.join("Default/linked.txt"),
    )
    .unwrap();
    symlink(&secret, layout.rnw_chromium.join("Ardia p-linked")).unwrap();
    fs::hard_link(
        secret.join("passwords.txt"),
        layout.rnw_chromium.join("Default/hard.txt"),
    )
    .unwrap();
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::MigratedWithSkips);
    let counted = counts(&report);
    assert_eq!(counted["skipped_links"], 3);
    assert_eq!(counted["skipped_invalid"], 1);
    let chromium = webui_chromium(&layout);
    assert!(!chromium.join("Ardia p-linked").exists());
    for path in files(&chromium).keys() {
        assert!(!path.contains("inked") && !path.contains("hard"), "{path}");
    }
}

#[test]
fn merging_a_local_state_keeps_every_other_field() {
    let existing = json!({ "a": 1, "os_crypt": { "encrypted_key": "old", "app_bound_encrypted_key": "old" } });
    let crypt = json!({ "encrypted_key": "new" });
    let merged: Value = serde_json::from_slice(&merged_local_state(existing.as_object(), &crypt)).unwrap();
    assert_eq!(merged, json!({ "a": 1, "os_crypt": { "encrypted_key": "new" } }));
    let fresh: Value = serde_json::from_slice(&merged_local_state(None, &crypt)).unwrap();
    assert_eq!(fresh, json!({ "os_crypt": crypt }));
}

#[test]
fn base64_round_trips_and_rejects_junk() {
    for length in 0..40 {
        let bytes: Vec<u8> = (0..length).map(|i| (i * 37 + 11) as u8).collect();
        assert_eq!(base64_decode(&base64(&bytes)).unwrap(), bytes, "{length}");
    }
    for junk in ["***", "A", "AB=C", "ABC===", "AB\nC"] {
        assert!(base64_decode(junk).is_none(), "{junk}");
    }
}

#[test]
fn profile_folders_map_the_way_both_shells_name_them() {
    assert_eq!(names::webui_profile_folder("Default").as_deref(), Some("Ardia default"));
    assert_eq!(
        names::webui_profile_folder("Ardia p-1a2b").as_deref(),
        Some("Ardia p-1a2b")
    );
    for refused in [
        "default",
        "Ardia ",
        "Ardia P-1",
        "Ardia a b",
        "Ardia a_b",
        "Profile 1",
        "System Profile",
        "Ardia ü",
    ] {
        assert_eq!(names::webui_profile_folder(refused), None, "{refused}");
    }
    assert!(names::profile_transient(&[], "Cache"));
    assert!(names::profile_transient(&[], "code cache"));
    assert!(names::profile_transient(&["Service Worker".into()], "CacheStorage"));
    assert!(!names::profile_transient(&["Service Worker".into()], "Database"));
    assert!(!names::profile_transient(&["Network".into()], "Cache"));
    assert!(names::profile_transient(&["IndexedDB".into(), "x".into()], "LOCK"));
    assert!(!names::profile_transient(&[], "History"));
}

#[test]
fn an_oversized_webui_local_state_is_moved_aside_whole() {
    let scratch = Scratch::new("chromium-huge-webui-state");
    let sealer = FakeDpapi::new();
    let layout = layout(&scratch.0);
    let rnw_state = seed_rnw(&layout, &sealer);
    let huge = vec![b' '; ardia_shell_migration::chromium::LOCAL_STATE_LIMIT as usize + 1];
    write(&webui_chromium(&layout).join(names::LOCAL_STATE), &huge);
    let report = run(&layout, &sealer);
    assert_eq!(report.outcome, Outcome::Migrated);
    assert_eq!(local_state(&layout), json!({ "os_crypt": rnw_state["os_crypt"] }));
    assert_eq!(kept_files(&layout)[names::LOCAL_STATE].len(), huge.len());
    assert_eq!(counts(&report)["local_state_malformed"], 1);
}
