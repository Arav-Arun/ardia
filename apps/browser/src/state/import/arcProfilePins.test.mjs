import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;
globalThis.fetch = async () => ({ status: 200 });

let spaces = [];
globalThis.acTestNativeModules = {
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    isBrowserUnlocked: () => true,
    listExtensions: async () => "[]",
    importData: async () =>
      JSON.stringify({
        browserId: "arc",
        profileId: "Default",
        history: [],
        historyCount: 0,
        tabs: [],
        tabGroups: [],
        credentials: [],
        cookieCount: 0,
        addressCount: 0,
        cardCount: 0,
        spaces,
        favorites: [],
        favicons: [],
        failed: [],
        warnings: [],
      }),
  },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { patchImport } = await import("./flow.ts");
const { runImport } = await import("./runImport.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../session/persist.ts");
const { startWindowCloseGuard } = await import("../windows/windowClose.ts");
const { shellNativeModules, windows } = await import("../../test-native/shell.ts");
shellNativeModules.ArdiaDialogs.confirm = () => Promise.resolve({ confirmed: true, suppressed: false });
startWindowCloseGuard();

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const link = (name) => ({ type: "url", url: `https://${name}.example/`, title: name });
const arcSpace = (id, name) => ({
  id,
  name,
  profileId: "Default",
  pinned: [link(`${id}-row`), { type: "folder", title: `${name} folder`, children: [link(`${id}-one`), link(`${id}-two`)] }],
  tabs: [{ url: `https://${id}-today.example/`, title: "Today" }],
});
const source = {
  id: "arc",
  name: "Arc",
  family: "arc",
  requiresExport: false,
  needsKeychain: false,
  sidebar: "arc",
  profiles: [{ id: "Default", name: "Default", path: "/arc", isDefault: true, available: ["spaces"], spaces: [] }],
};

function pinsByProfile() {
  const s = S();
  const pinnedUrls = (profileId) => [
    ...Object.values(s.tabs).filter((t) => t.profileId === profileId && t.pin).map((t) => t.pinnedUrl ?? t.url),
    ...Object.values(s.groups).filter((g) => g.profileId === profileId && g.pinned).flatMap((g) => g.tabIds.map((id) => s.tabs[id]?.url)),
    ...(s.parkedPins[profileId]?.tabs ?? []).map((t) => t.pinnedUrl ?? t.url),
  ];
  return Object.fromEntries(s.profileOrder.map((id) => [s.profiles[id].name, [...new Set(pinnedUrls(id))].sort()]));
}

async function closeWindow(id) {
  windows.emit({ type: "closeRequest", id });
  await tick();
  await tick();
}

function relaunch() {
  flushPersistence();
  S().hydrate(loadSession());
}

async function importArcProfiles() {
  S().createWindow({ url: "https://start.example/" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  spaces = [arcSpace("work", "Work"), arcSpace("home", "Home"), arcSpace("side", "Side")];
  patchImport({ source, sourceProfiles: ["Default"], spaces: spaces.map((s) => s.id), target: "default", kinds: new Set(["spaces"]) });
  await runImport(new Set(["spaces"]));
  const [first, home, side] = S().profileOrder;
  return { window: S().windowOrder[0], first, home, side, imported: pinsByProfile() };
}

async function showEveryProfileThenRelaunch() {
  for (const w of [...S().windowOrder]) for (const p of [...S().profileOrder]) S().switchProfile(w, p);
  await tick();
  relaunch();
}

const steps = {
  "inactive-tab clean-up sweeps every window and every hidden profile": async ({ window, home }) => {
    const second = S().createWindow({});
    S().switchProfile(second, home);
    for (const id of [...S().windowOrder]) {
      S().cleanUpTabs(id, { inactiveForMs: 0 });
      S().cleanUpTabs(id, { inactiveForMs: 0, hiddenProfilesUpTo: 1000 });
    }
    await closeWindow(window);
  },
  "every profile was shown in the first window, then a second window opened and the first closed": async ({ window, first, home, side }) => {
    S().switchProfile(window, home);
    S().switchProfile(window, side);
    S().switchProfile(window, first);
    S().createWindow({});
    await closeWindow(window);
  },
  "a second window showed one imported profile, then the first window closed": async ({ window, home }) => {
    const second = S().createWindow({});
    S().switchProfile(second, home);
    await closeWindow(window);
  },
  "two windows on two imported profiles were saved, relaunched, then one closed": async ({ window, home, side }) => {
    S().switchProfile(window, home);
    const second = S().createWindow({});
    S().switchProfile(second, side);
    await tick();
    relaunch();
    await closeWindow(S().windowOrder[0]);
  },
  "a profile made later shares an imported profile's data and is shown in the window left open": async ({ window, first, home, side }) => {
    const extra = S().createProfile({ name: "Extra", shareWith: home });
    for (const p of [extra, home, side, first]) S().switchProfile(window, p);
    const second = S().createWindow({});
    S().switchProfile(second, extra);
    await closeWindow(window);
  },
};

for (const [name, run] of Object.entries(steps)) {
  test(`Arc spaces imported as profiles keep their pinned tabs and pinned folders when ${name} (#2814)`, async () => {
    stub.docs.clear();
    useBrowser.setState({ bookmarks: { nodes: {} } });
    S().hydrate({});
    const stop = startPersistence();
    try {
      const imported = await importArcProfiles();
      assert.deepEqual(imported.imported.Home, ["https://home-one.example/", "https://home-row.example/", "https://home-two.example/"]);
      await run(imported);
      await showEveryProfileThenRelaunch();
      const now = pinsByProfile();
      for (const profile of ["Work", "Home", "Side"]) assert.deepEqual(now[profile], imported.imported[profile], `${profile} keeps its pins`);
      assert.equal(Object.values(S().parkedPins).reduce((n, p) => n + p.tabs.length, 0), 0, "every profile was shown again, so nothing is left parked");
    } finally {
      stop();
    }
  });
}
