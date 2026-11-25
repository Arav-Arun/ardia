import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "../../browser/src/state/settings/settingsWindows.ts";
import { windows } from "../../browser/src/test-native/index.ts";
import * as linux from "./settingsWindows.ts";
import { setSessionFlush } from "./session.ts";

test("Linux Settings shares navigation actions and opens the requested native utility only after saving", async () => {
  assert.equal(linux.useSettingsNav, shared.useSettingsNav);
  assert.equal(linux.goToSettingsPane, shared.goToSettingsPane);
  windows.open.clear();
  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  let saved;
  setSessionFlush(() => new Promise((resolve) => { saved = resolve; }));

  assert.equal(linux.openSettings("profiles", "work"), undefined);
  assert.equal(windows.open.has("settings"), false);
  assert.equal(shared.useSettingsNav.getState().pane, "profiles");
  assert.equal(shared.useSettingsNav.getState().profileId, "work");
  saved();
  await new Promise(setImmediate);
  assert.deepEqual(windows.open.get("settings"), {
    kind: "settings",
    title: "Settings",
    settings: { pane: "profiles", profileId: "work", detail: null },
  });
  assert.deepEqual(shared.useSettingsNav.getState().back, [{ pane: "general", profileId: null, detail: null }]);

  linux.settingsBack();
  assert.equal(shared.useSettingsNav.getState().pane, "general");
  linux.settingsForward();
  assert.equal(shared.useSettingsNav.getState().pane, "profiles");
});

test("Linux Import retains its consume-once source and waits for the session save before native opening", async () => {
  windows.open.clear();
  linux.setPreferredImportSource("firefox");
  assert.equal(linux.takePreferredImportSource(), "firefox");
  assert.equal(linux.takePreferredImportSource(), null);
  let saved;
  setSessionFlush(() => new Promise((resolve) => { saved = resolve; }));
  assert.equal(linux.openImport("chromium"), undefined);
  assert.equal(windows.open.has("import"), false);
  saved();
  await new Promise(setImmediate);
  assert.deepEqual(windows.open.get("import"), {
    kind: "import",
    title: "Import from Another Browser",
    importSource: "chromium",
  });
});

test("Manage Extensions on Linux and Windows carries the Extensions row to the Settings window, which reveals it there; a detail page still opens on Linux", async () => {
  const { useSettingsSearch, setSettingsQuery } = await import("../../browser/src/state/settings/searchState.ts");
  const { navigateUtility } = await import("./utilityPlace.ts");
  windows.open.clear();
  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  setSessionFlush(() => Promise.resolve());
  linux.openSettings("profiles", "work", null, "profiles.extensions");
  await new Promise(setImmediate);
  const request = windows.open.get("settings");
  assert.deepEqual(request.settings, { pane: "profiles", profileId: "work", detail: null, reveal: "profiles.extensions" });

  shared.useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  setSettingsQuery("cookies");
  useSettingsSearch.setState({ reveal: null });
  navigateUtility(JSON.parse(JSON.stringify(request.settings)));
  const nav = shared.useSettingsNav.getState();
  assert.deepEqual([nav.pane, nav.profileId, nav.detail], ["profiles", "work", null]);
  assert.equal(useSettingsSearch.getState().reveal?.id, "profiles.extensions");
  assert.equal(useSettingsSearch.getState().query, "");

  useSettingsSearch.setState({ reveal: null });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: "general.importBrowser" });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: "profiles.nope" });
  navigateUtility({ pane: "profiles", profileId: "work", detail: null, reveal: 7 });
  assert.equal(useSettingsSearch.getState().reveal, null, "a row from another pane, an unknown row or a non-string is ignored");

  linux.openSettings("profiles", "work", "site:https://example.com");
  await new Promise(setImmediate);
  assert.deepEqual(windows.open.get("settings").settings, { pane: "profiles", profileId: "work", detail: "site:https://example.com" });
});
