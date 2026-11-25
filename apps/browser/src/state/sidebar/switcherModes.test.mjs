import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { sidebarUi } = await import("./sidebarUi.ts");
const { cancelSwitcher, closeSwitcherRow, commitSwitcher, switcherStep, SHOW_AFTER_MS } = await import("./switcher.ts");
const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
const { inOrderTabIds } = await import("../tabs/switchOrder.ts");

let clock = Date.now();
Date.now = () => (clock += 1000);
const S = () => useBrowser.getState();
const shown = (w) => S().tabs[activeTabId(S(), w)].url.replace(/^https:\/\/|\.com\/?$/g, "");
const pastShow = () => {
  mock.timers.tick(SHOW_AFTER_MS + 1);
};

function setup(order, view, ...urls) {
  S().hydrate({});
  S().updateSettings({ tabSwitcherOrder: order, tabSwitcherView: view, newTabPosition: "bottom" });
  const w = S().createWindow({ url: `https://${urls[0]}.com` });
  const ids = [S().windows[w].tabIds[0], ...urls.slice(1).map((url) => S().newTab(w, { url: `https://${url}.com` }))];
  return [w, ...ids];
}

mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

afterEach(() => {
  cancelSwitcher();
  useLifecycle.setState({ discarded: {} });
});

test("recent with no switcher shown: hold ⌃ and tap Tab twice to land on the third most recent tab when ⌃ comes up", () => {
  const [w, a, b, c] = setup("recent", "none", "a", "b", "c");
  S().activate(a);
  S().activate(b);
  S().activate(c);
  switcherStep(w, false);
  assert.equal(shown(w), "c", "nothing switches on the press");
  switcherStep(w, false);
  assert.equal(shown(w), "c", "nor on the second tap");
  assert.equal(sidebarUi().switcher.mounted, false, "nothing is drawn");
  commitSwitcher();
  assert.equal(shown(w), "a");
});

test("in order with no switcher shown: each tap moves at once, down the list and back", () => {
  const [w, a] = setup("inOrder", "none", "a", "b", "c");
  S().activate(a);
  switcherStep(w, false);
  assert.equal(shown(w), "b");
  assert.equal(sidebarUi().switcher, null);
  switcherStep(w, false);
  assert.equal(shown(w), "c");
  switcherStep(w, false);
  assert.equal(shown(w), "a", "it wraps around");
  switcherStep(w, true);
  assert.equal(shown(w), "c");
});

test("a quick tap with a switcher picked switches at once and never shows it", () => {
  for (const view of ["thumbnails", "compactList"]) {
    const [w, a, b] = setup("recent", view, "a", "b");
    S().activate(a);
    S().activate(b);
    switcherStep(w, false);
    commitSwitcher();
    assert.equal(shown(w), "a", view);
    pastShow();
    assert.equal(sidebarUi().switcher, null, view);
  }
});

test("holding shows the picked switcher, in order lists the tabs as the sidebar does, and Esc leaves the tab as it was", () => {
  const [w, a, b, c] = setup("inOrder", "compactList", "a", "b", "c");
  S().activate(b);
  switcherStep(w, false);
  pastShow();
  const switcher = sidebarUi().switcher;
  assert.equal(switcher.view, "compactList");
  assert.equal(switcher.visible, true);
  assert.deepEqual(switcher.ids, [a, b, c]);
  assert.equal(switcher.ids[switcher.index], c);
  cancelSwitcher();
  assert.equal(shown(w), "b");
});

test("⌃W closes the selected row while a switcher shows, and does nothing when none is shown", async () => {
  const [w, a, b, c] = setup("recent", "thumbnails", "a", "b", "c");
  S().activate(a);
  S().activate(b);
  S().activate(c);
  switcherStep(w, false);
  await closeSwitcherRow();
  assert.ok(!S().tabs[b], "the highlighted tab closed");
  assert.ok(sidebarUi().switcher, "the switcher stays up");
  cancelSwitcher();

  const [w2, x, y] = setup("recent", "none", "x", "y");
  S().activate(x);
  S().activate(y);
  switcherStep(w2, false);
  await closeSwitcherRow();
  assert.ok(S().tabs[x], "an unseen row is never closed");
});

test("both orders skip closed pinned tabs and tabs Memory Saver put to sleep", () => {
  const [w, a, b, c] = setup("inOrder", "none", "a", "b", "c");
  S().activate(a);
  S().updateTab(b, { page: { kind: "asleep" } });
  useLifecycle.setState({ discarded: { [c]: true } });
  assert.deepEqual(inOrderTabIds(S(), w), [a]);
  switcherStep(w, false);
  assert.equal(shown(w), "a");
  S().cycle(w, 1);
  assert.equal(shown(w), "a", "Next Tab skips them too");
});
