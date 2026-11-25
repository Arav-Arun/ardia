import assert from "node:assert/strict";
import { test } from "node:test";
const { withTabSwitcherModes, TAB_SWITCHER_MODES_APPLIED } = await import("./tabSwitcherUpgrade.ts");
const { SESSION_VERSION } = await import("../session/savedSession.ts");

const SWITCHER = { "tabSwitcher:forward": ["\t", "control"], "tabSwitcher:backward": ["\t", "control", "shift"] };
const meta = (chosen = [], inferred = []) => ({ chosen, inferred });
const mac = (settings, m) => withTabSwitcherModes(settings, m, true);

test("the upgrade needs no new session version, so 0.2.47 still opens what this build saves", () => {
  assert.equal(SESSION_VERSION, 11);
});

test("a Mac whose shortcuts were chosen keeps stepping through tabs, once, and the choice counts as made", () => {
  const once = mac({ shortcuts: { closeTab: ["w", "command", "shift"] } }, meta(["shortcuts"]));
  assert.equal(once.settings.tabSwitcherOrder, "inOrder");
  assert.equal(once.settings.tabSwitcherView, "none");
  assert.ok(once.settingsMeta.chosen.includes("tabSwitcherOrder") && once.settingsMeta.chosen.includes("tabSwitcherView"));
  assert.ok(once.settingsMeta.inferred.includes(TAB_SWITCHER_MODES_APPLIED));
  const again = mac({ ...once.settings, tabSwitcherOrder: "recent" }, once.settingsMeta);
  assert.equal(again.settings.tabSwitcherOrder, "recent", "a later pick is never undone");
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
