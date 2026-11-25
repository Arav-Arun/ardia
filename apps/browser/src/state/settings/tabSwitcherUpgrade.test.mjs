import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { withTabSwitcherModes, withSyncedTabSwitcherModes, TAB_SWITCHER_MODES_APPLIED } = await import("./tabSwitcherUpgrade.ts");
const { SESSION_VERSION } = await import("../session/savedSession.ts");
const { useBrowser } = await import("../browser/store.ts");
const { settingsAdapter } = await import("../sync/settingsAdapter.ts");
const { ctrlTabKeys } = await import("../commands/commandShortcuts.ts");

const SWITCHER = { "tabSwitcher:forward": ["\t", "control"], "tabSwitcher:backward": ["\t", "control", "shift"] };
const STEP = { nextTab: ["\t", "control"], previousTab: ["\t", "control", "shift"] };
const meta = (chosen = [], inferred = []) => ({ chosen, inferred });
const mac = (settings, m) => withTabSwitcherModes(settings, m, true);
const S = () => useBrowser.getState();

test("the upgrade needs no new session version, so 0.2.47 still opens what this build saves", () => {
  assert.equal(SESSION_VERSION, 11);
});

test("Next Tab and Previous Tab bound to ⌃Tab become stepping, once, and the choice counts as made", () => {
  const once = mac({ shortcuts: { ...STEP, closeTab: ["w", "command", "shift"] } }, meta(["shortcuts"]));
  assert.deepEqual(once.settings.shortcuts, { closeTab: ["w", "command", "shift"] });
  assert.equal(once.settings.tabSwitcherOrder, "inOrder");
  assert.equal(once.settings.tabSwitcherView, "none");
  assert.ok(once.settingsMeta.chosen.includes("tabSwitcherOrder") && once.settingsMeta.chosen.includes("tabSwitcherView"));
  assert.ok(once.settingsMeta.inferred.includes(TAB_SWITCHER_MODES_APPLIED));
  const again = mac({ ...once.settings, tabSwitcherOrder: "recent" }, once.settingsMeta);
  assert.equal(again.settings.tabSwitcherOrder, "recent", "a later pick is never undone");
});

test("an unrelated shortcut edit leaves the switcher on its new default and chooses nothing", () => {
  const saved = { shortcuts: { closeTab: ["w", "command", "shift"] } };
  const { settings, settingsMeta } = mac(saved, meta(["shortcuts"]));
  assert.deepEqual(settings, saved);
  assert.deepEqual(settingsMeta, meta(["shortcuts"], [TAB_SWITCHER_MODES_APPLIED]));
});

test("a Mac that only stepped by default moves to the recent switcher and its settings are left as saved", () => {
  const saved = { tabLayout: "top" };
  const { settings, settingsMeta } = mac(saved, meta());
  assert.deepEqual(settings, saved);
  assert.deepEqual(settingsMeta, meta([], [TAB_SWITCHER_MODES_APPLIED]));
});

test("the old switcher card's overrides go, since the default now does the same", () => {
  const { settings } = mac({ shortcuts: { ...SWITCHER, closeTab: ["w", "command"] } }, meta(["shortcuts"]));
  assert.deepEqual(settings.shortcuts, { closeTab: ["w", "command"] });
  assert.equal("tabSwitcherOrder" in settings, false);
});

test("a fresh install only marks the upgrade done", () => {
  assert.deepEqual(withTabSwitcherModes(undefined, meta()), { settings: undefined, settingsMeta: meta([], [TAB_SWITCHER_MODES_APPLIED]) });
});

test("a synced patch from an older Ardia that steps with ⌃Tab turns into stepping here, and one from a newer Ardia is left alone", () => {
  assert.deepEqual(withSyncedTabSwitcherModes({ shortcuts: { ...STEP } }, false), { shortcuts: {}, tabSwitcherOrder: "inOrder", tabSwitcherView: "none" });
  const newer = { shortcuts: { ...STEP }, tabSwitcherOrder: "recent" };
  assert.equal(withSyncedTabSwitcherModes(newer, false), newer);
  const alongside = { shortcuts: { ...STEP } };
  assert.equal(withSyncedTabSwitcherModes(alongside, true), alongside, "a mode record already in sync means the shortcuts are someone's own");
});

test("a legacy shortcuts record that sync applies after launch keeps ⌃Tab and the settings in agreement", () => {
  S().hydrate({});
  assert.equal(S().settings.tabSwitcherOrder, "recent");
  settingsAdapter.apply(new Map([["set:shortcuts", { v: { ...STEP } }]]), ["set:shortcuts"]);
  assert.equal(S().settings.tabSwitcherOrder, "inOrder");
  assert.equal(S().settings.tabSwitcherView, "none");
  assert.deepEqual(S().settings.shortcuts, {});
  assert.equal(ctrlTabKeys(), "switcher");
});

test("the same records give the same result whichever order sync delivers them in", () => {
  const modes = [["set:tabSwitcherOrder", { v: "recent" }], ["set:tabSwitcherView", { v: "compactList" }]];
  const keys = [["set:shortcuts", { v: { ...STEP } }]];
  const outcome = (batches) => {
    S().hydrate({});
    const visible = new Map();
    for (const batch of batches) {
      for (const [key, record] of batch) visible.set(key, record);
      settingsAdapter.apply(visible, batch.map(([key]) => key));
    }
    const { tabSwitcherOrder, tabSwitcherView, shortcuts } = S().settings;
    return { tabSwitcherOrder, tabSwitcherView, shortcuts };
  };
  const together = outcome([[...modes, ...keys]]);
  assert.deepEqual(together, { tabSwitcherOrder: "recent", tabSwitcherView: "compactList", shortcuts: { ...STEP } });
  assert.deepEqual(outcome([modes, keys]), together, "modes first, shortcuts second");
  assert.deepEqual(outcome([keys, modes]), together, "shortcuts first, modes second");
});
