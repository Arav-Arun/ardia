import assert from "node:assert/strict";
import { test } from "node:test";
const { resolveShortcuts, formatShortcut, parseShortcut } = await import("./shortcuts.ts");
const { staticShortcutSources } = await import("./commandCatalog.ts");
const { ctrlTabKeysOf, ctrlTabCombos, ctrlTabCustomTarget, ctrlTabOverrides, ctrlTabUpgrade } = await import("./ctrlTabKeys.ts");
const { ctrlTabCustomQuery } = await import("./commandShortcuts.ts");
const { parseWindowsShortcut, windowsDefaultKeys, windowsModifiers, formatWindowsShortcut } = await import("./windowsKeys.ts");

const macSources = staticShortcutSources();
const mac = (overrides) => resolveShortcuts(macSources, overrides);
const hints = (resolved, id) => (resolved.bindings.get(id) ?? []).map(formatShortcut);
const SWITCHER = { "tabSwitcher:forward": ["\t", "control"], "tabSwitcher:backward": ["\t", "control", "shift"] };
const restore = (overrides, resolve = mac) => ctrlTabOverrides(overrides, ctrlTabCombos(resolve(overrides)), resolve(overrides).defaultsOf);

test("⌃⇥ and ⌃⇧⇥ open the tab switcher by default, and Next Tab keeps its other keys", () => {
  assert.equal(ctrlTabKeysOf(mac({})), "switcher");
  assert.deepEqual(hints(mac({}), "tabSwitcher:forward"), ["⌃⇥"]);
  assert.deepEqual(hints(mac({}), "tabSwitcher:backward"), ["⌃⇧⇥"]);
  assert.ok(!hints(mac({}), "nextTab").includes("⌃⇥"));
  assert.ok(hints(mac({}), "nextTab").includes("⇧⌘]"));
});

test("⌃⇥ on another command, one direction moved, or the switcher cleared reads as custom", () => {
  assert.equal(ctrlTabKeysOf(mac({ newTab: ["\t", "control"] })), "custom");
  assert.equal(ctrlTabKeysOf(mac({ nextTab: ["\t", "control"] })), "custom");
  assert.equal(ctrlTabKeysOf(mac({ "tabSwitcher:forward": ["\t", "option"] })), "custom");
  assert.equal(ctrlTabKeysOf(mac({ "tabSwitcher:backward": [""] })), "custom");
});

test("Use ⌃Tab gives both keys back to the switcher and keeps unrelated shortcuts", () => {
  const custom = { newTab: ["\t", "control"], "tabSwitcher:forward": ["\t", "option"], closeTab: ["w", "command"] };
  const restored = restore(custom);
  assert.deepEqual(restored, { closeTab: ["w", "command"] });
  assert.equal(ctrlTabKeysOf(mac(restored)), "switcher");
  assert.deepEqual(restore({}), {});
});

const windowsSources = macSources.map((source) => ({ ...source, keys: windowsDefaultKeys(source.id).map(parseWindowsShortcut) }));
const windows = (overrides) => resolveShortcuts(windowsSources, overrides, windowsModifiers);

test("on Windows the switcher sits on Ctrl+Tab and Ctrl+Shift+Tab", () => {
  const combos = ctrlTabCombos(windows({}));
  assert.equal(formatWindowsShortcut(combos.forward), "Ctrl+Tab");
  assert.equal(formatWindowsShortcut(combos.backward), "Ctrl+Shift+Tab");
  assert.equal(ctrlTabKeysOf(windows({})), "switcher");
});

const LINUX_KEYS = { nextTab: ["⇧⌘]", "⌘⇟", "⌥⌘↓"], previousTab: ["⇧⌘[", "⌘⇞", "⌥⌘↑"], "tabSwitcher:forward": ["⌘⇥"], "tabSwitcher:backward": ["⇧⌘⇥"] };
const linuxSources = macSources.map((source) => (LINUX_KEYS[source.id] ? { ...source, keys: LINUX_KEYS[source.id].map(parseShortcut) } : source));
const linux = (overrides) => resolveShortcuts(linuxSources, overrides);

test("on Linux, where Ctrl is stored as command, Ctrl+Tab is the switcher too", () => {
  assert.equal(ctrlTabKeysOf(linux({})), "switcher");
  assert.equal(ctrlTabKeysOf(linux({ nextTab: ["\t", "command"] })), "custom");
});

test("Show in Shortcuts searches for the key that left the switcher, or the switcher by name", () => {
  assert.equal(formatShortcut(ctrlTabCustomTarget(mac({ newTab: ["\t", "control", "shift"] })).combo), "⌃⇧⇥");
  assert.equal(formatShortcut(ctrlTabCustomTarget(mac({ newTab: ["\t", "control"] })).combo), "⌃⇥");
  assert.deepEqual(ctrlTabCustomTarget(mac({ "tabSwitcher:forward": [""] })), { command: "tabSwitcher:forward" });
  assert.equal(ctrlTabCustomQuery({ settings: { shortcuts: { "tabSwitcher:forward": [""] } }, profileOrder: [] }), "Tab Switcher (forward)");
});

const upgradeMac = (overrides, choseShortcuts = false) => ctrlTabUpgrade(overrides, macSources, { usedToStep: true, choseShortcuts });
const upgradeLinux = (overrides, choseShortcuts = false) => ctrlTabUpgrade(overrides, linuxSources, { usedToStep: false, choseShortcuts });

test("upgrading a Mac that picked the recent tabs switcher drops the overrides it no longer needs", () => {
  const { shortcuts, stepped } = upgradeMac({ ...SWITCHER, closeTab: ["w", "command"] }, true);
  assert.deepEqual(shortcuts, { closeTab: ["w", "command"] });
  assert.equal(stepped, false);
  assert.equal(ctrlTabKeysOf(mac(shortcuts)), "switcher");
});

test("upgrading a Mac that stepped only because that was the default moves to the new default", () => {
  const before = {};
  const { shortcuts, stepped } = upgradeMac(before);
  assert.equal(shortcuts, before);
  assert.equal(stepped, false);
});

test("upgrading a Mac where someone chose their shortcuts keeps stepping through tabs", () => {
  const before = { closeTab: ["w", "command", "shift"] };
  const { shortcuts, stepped } = upgradeMac(before, true);
  assert.equal(shortcuts, before);
  assert.equal(stepped, true);
});

test("upgrading Linux's step card drops its single-key Next Tab overrides and keeps stepping", () => {
  const { shortcuts, stepped } = upgradeLinux({ nextTab: ["\t", "command"], previousTab: ["\t", "shift", "command"], closeTab: ["w", "command"] }, true);
  assert.deepEqual(shortcuts, { closeTab: ["w", "command"] });
  assert.equal(stepped, true);
  assert.equal(ctrlTabKeysOf(linux(shortcuts)), "switcher");
  assert.ok(hints(linux(shortcuts), "nextTab").includes("⇧⌘]"));
});

test("upgrading Linux's default leaves everything alone", () => {
  const before = {};
  assert.deepEqual(upgradeLinux(before), { shortcuts: before, stepped: false });
});

test("custom keys survive an upgrade, and a switcher bound elsewhere is never turned into stepping", () => {
  const custom = { newTab: ["\t", "control"] };
  assert.deepEqual(upgradeMac(custom, true), { shortcuts: custom, stepped: false });
  const elsewhere = { "tabSwitcher:forward": ["\t", "option"], "tabSwitcher:backward": ["\t", "option", "shift"] };
  assert.deepEqual(upgradeMac(elsewhere, true), { shortcuts: elsewhere, stepped: false });
});
