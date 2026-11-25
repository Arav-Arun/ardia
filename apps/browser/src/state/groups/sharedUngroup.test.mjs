import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { inPinnedContainer, pinKeyOf, viewTabIds } = await import("../browser/model.ts");
const { hasPage } = await import("../tabs/pageSession.ts");
const { splitTabIds } = await import("../splits/splits.ts");
const { createGroupsSlice } = await import("./groups.ts");

const S = () => useBrowser.getState();
const groupIn = (windowId, key) => Object.values(S().groups).find((g) => g.windowId === windowId && pinKeyOf(g) === key);
const rows = (windowId) => viewTabIds(S(), windowId).map((id) => S().tabs[id]);
const family = (key) => Object.values(S().tabs).filter((t) => pinKeyOf(t) === key);

function windows(shared = true, count = 2) {
  S().hydrate({});
  const a = S().createWindow({ url: "https://one.example/" });
  const one = S().windows[a].tabIds[0];
  const all = [a];
  for (let n = 1; n < count; n++) all.push(S().createWindow({ url: n === 1 ? "https://two.example/" : `https://other${n}.example/` }));
  const two = S().windows[all[1]].tabIds.find((id) => S().tabs[id].url === "https://two.example/");
  S().updateSettings({ shareTabsAcrossWindows: shared });
  if (!shared) S().newTab(all[1], { url: "https://one.example/", background: true });
  const members = ["https://one.example/", "https://two.example/"].map((url) => rows(all[1]).find((t) => t.url === url).id);
  const group = S().groupTabs(members, { pinned: true, name: "Reading" });
  return { a, b: all[1], all, one, two, group };
}

function keptPages(ids, before) {
  for (const id of ids) {
    assert.ok(S().tabs[id], `the live tab ${id} survives`);
    assert.deepEqual(S().tabs[id].page.nav, before[id], "the existing page survives without a reload");
    assert.equal(family(id).filter(hasPage).length, 1, "one loaded page per family");
  }
}

for (const origin of ["original window", "mirror window"]) {
  test(`ungrouping a shared pinned folder from its ${origin} keeps its tabs in every window`, () => {
    const { a, b, all, one, two, group } = windows(true, 3);
    const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
    const closed = S().closedTabs;
    const closedGroups = S().closedGroups;
    const key = pinKeyOf(S().groups[group]);
    S().ungroup(groupIn(origin === "original window" ? b : a, key).id);
    keptPages([one, two], before);
    for (const w of all) {
      assert.equal(groupIn(w, key), undefined, "the folder is removed in every window");
      for (const id of [one, two]) {
        const copies = rows(w).filter((t) => pinKeyOf(t) === id);
        assert.equal(copies.length, 1, "each tab remains listed once");
        assert.equal(inPinnedContainer(S(), copies[0].id), false, "its tab is now in the regular list");
      }
    }
    assert.equal(S().closedTabs, closed, "ungroup does not close tabs");
    assert.equal(S().closedGroups, closedGroups, "ungroup does not close the folder's pages");
  });
}

test("ungrouping a shared pinned root keeps nested folders rooted in every window", () => {
  const { b, all, one, two, group } = windows();
  const inner = S().groupTabs([two], { name: "Nested" });
  assert.equal(S().groups[inner].parentId, group);
  const outerKey = pinKeyOf(S().groups[group]);
  const innerKey = pinKeyOf(S().groups[inner]);
  const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
  S().ungroup(groupIn(b, outerKey).id);
  for (const w of all) {
    assert.equal(groupIn(w, outerKey), undefined);
    const child = groupIn(w, innerKey);
    assert.ok(child, "the nested folder survives");
    assert.equal(child.parentId, undefined);
    assert.equal(child.pinned, true);
    assert.deepEqual(child.tabIds.map((id) => pinKeyOf(S().tabs[id])), [two]);
    assert.equal(rows(w).filter((t) => pinKeyOf(t) === one).length, 1);
  }
  keptPages([one, two], before);
});

test("ungrouping a shared nested folder keeps its tabs inside the parent", () => {
  const { b, all, one, two, group } = windows();
  const inner = S().groupTabs([two], { name: "Nested" });
  const outerKey = pinKeyOf(S().groups[group]);
  const innerKey = pinKeyOf(S().groups[inner]);
  const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
  S().ungroup(groupIn(b, innerKey).id);
  for (const w of all) {
    assert.equal(groupIn(w, innerKey), undefined);
    const parent = groupIn(w, outerKey);
    assert.ok(parent);
    assert.equal(parent.pinned, true);
    assert.deepEqual(parent.tabIds.map((id) => pinKeyOf(S().tabs[id])), [one, two]);
  }
  keptPages([one, two], before);
});

const splitsIn = (w) => Object.values(S().splits).filter((v) => v.windowId === w);

function oneCopyInSplitWindows(all) {
  for (const w of all) {
    const own = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default");
    for (const v of splitsIn(w)) {
      for (const id of splitTabIds(v)) {
        const url = S().tabs[id].url;
        assert.equal(own.filter((t) => t.url === url).length, 1, `exactly one copy of ${url} in the split window`);
      }
    }
  }
}

function splitFolder(home) {
  const fixture = windows(true, 3);
  S().setFocusedWindow(fixture.b);
  S().createSplit(S().groups[fixture.group].tabIds);
  const split = splitsIn(fixture.b)[0];
  assert.ok(split);
  assert.equal(Object.values(S().splits).length, fixture.all.length, "a pinned split is mirrored in every window");
  const key = pinKeyOf(S().groups[fixture.group]);
  const before = Object.fromEntries([fixture.one, fixture.two].map((id) => [id, S().tabs[id].page.nav]));
  const to = home === "original window" ? fixture.b : fixture.a;
  S().setFocusedWindow(to);
  S().ungroup(groupIn(to, key).id);
  return { ...fixture, to, split, before };
}

for (const home of ["original window", "mirror window"]) {
  test(`ungrouping a shared folder from its ${home} keeps its split there, once, with its live pages`, () => {
    const { all, one, two, to, split, before } = splitFolder(home);
    const kept = Object.values(S().splits);
    assert.equal(kept.length, 1, "a regular split lives in one window");
    assert.equal(kept[0].windowId, to, "the window it was ungrouped from");
    assert.equal(kept[0].orientation, split.orientation);
    assert.deepEqual(splitTabIds(kept[0]).map((id) => pinKeyOf(S().tabs[id])), [one, two]);
    for (const w of all) {
      for (const id of [one, two]) assert.equal(rows(w).filter((t) => pinKeyOf(t) === id).length, w === to ? 1 : 0, "listed once, only beside its split");
    }
    oneCopyInSplitWindows(all);
    keptPages([one, two], before);
    for (const id of [one, two]) assert.equal(S().tabs[id].windowId, to, "the live pages moved into the split");
  });
}

test("grouping an ungrouped split again leaves no regular copy beside a pane in any window", () => {
  const { all, one, two, to } = splitFolder("mirror window");
  S().groupTabs(splitTabIds(splitsIn(to)[0]), { pinned: true, name: "Again" });
  oneCopyInSplitWindows(all);
  for (const w of all) {
    assert.equal(splitsIn(w).length, 1, "the pinned split is mirrored once per window");
    for (const id of [one, two]) assert.equal(rows(w).filter((t) => pinKeyOf(t) === id).length, 1);
  }
});

test("creating a split after a shared ungroup doesn't recreate a pane as a regular tab", () => {
  const { a, all, one, two, to } = splitFolder("original window");
  S().setFocusedWindow(a);
  const x = S().newTab(a, { url: "https://x.example/", background: true });
  const y = S().newTab(a, { url: "https://y.example/", background: true });
  assert.ok(S().createSplit([x, y]));
  oneCopyInSplitWindows(all);
  for (const w of all) {
    for (const id of [one, two]) assert.equal(rows(w).filter((t) => pinKeyOf(t) === id).length, w === to ? 1 : 0);
  }
  S().setFocusedWindow(to);
  const pane = splitTabIds(splitsIn(to)[0])[0];
  const z = S().newTab(to, { url: "https://z.example/", background: true });
  S().openSplitPane(to, { anchorTabId: pane, tabId: z });
  oneCopyInSplitWindows(all);
});

const site = (name) => `https://${name}.example/`;
const listed = (w, name) => S().windows[w].tabIds.filter((id) => S().tabs[id].url === site(name) && S().tabs[id].profileId === "default");
const tabIn = (w, name) => listed(w, name)[0];
const folderOf = (w, group) => Object.values(S().groups).find((g) => g.windowId === w && g.pinned && pinKeyOf(g) === pinKeyOf(S().groups[group]));

test("ungrouping a folder's mirror while another window is focused leaves one copy beside a split already open", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("x") });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("y") });
  S().newTab(b, { url: site("z") });
  S().setFocusedWindow(b);
  S().createSplit([tabIn(a, "y"), tabIn(a, "x")]);
  assert.equal(listed(a, "x").length, 1, "the split pane is A's only X");
  assert.equal(listed(b, "x").length, 0, "a regular split stays in its window");
  const group = S().groupTabs([tabIn(b, "x"), tabIn(b, "z")].filter(Boolean), { pinned: true });
  S().ungroup(folderOf(a, group).id);
  assert.equal(listed(a, "x").length, 1, "one X in A, the split pane");
  assert.ok(splitsIn(a).some((v) => splitTabIds(v).includes(tabIn(a, "x"))));
  oneCopyInSplitWindows([a, b]);
});

test("a split made after ungrouping, while another window is focused, doesn't recreate a pane as a regular tab", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("t1") });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("t2") });
  const c = S().createWindow({ url: site("t3") });
  for (const n of [4, 5, 6, 7]) S().newTab(a, { url: site(`t${n}`), background: true });
  const d = S().createWindow({ url: site("t8") });
  S().setFocusedWindow(c);
  const group = S().groupTabs([tabIn(b, "t1"), tabIn(b, "t3")], { pinned: true });
  S().activate(tabIn(d, "t3"));
  S().activate(tabIn(d, "t1"));
  S().groupTabs([tabIn(a, "t1"), tabIn(a, "t8")]);
  S().ungroup(folderOf(a, group).id);
  S().setFocusedWindow(a);
  S().setFocusedWindow(d);
  assert.ok(S().createSplit([tabIn(a, "t7"), tabIn(a, "t3")]));
  assert.equal(listed(a, "t7").length, 1, "one t7 in A, the split pane");
  assert.equal(listed(a, "t3").length, 1);
  oneCopyInSplitWindows([a, b, c, d]);
});

function splitOnlyFolder(extra) {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("two") });
  if (extra) S().newTab(b, { url: site(extra), background: true });
  const group = S().groupTabs([tabIn(b, "one"), tabIn(b, "two")], { pinned: true });
  S().setFocusedWindow(b);
  S().createSplit(S().groups[group].tabIds);
  assert.equal(splitsIn(a).length, 1, "the pinned split is mirrored");
  return { a, b, group };
}

test("ungrouping a split folder keeps open a window that held only its mirrored panes", () => {
  const { a, b, group } = splitOnlyFolder();
  S().ungroup(folderOf(b, group).id);
  assert.ok(S().windows[a], "the other window stays open");
  assert.ok(S().windowOrder.includes(a));
  assert.equal(S().windows[a].tabIds.filter((id) => S().tabs[id].profileId === "default").length, 1, "with a new tab in place of the panes");
  assert.equal(splitsIn(b).length, 1, "the split stays where it was ungrouped");
  oneCopyInSplitWindows([a, b]);
});

test("ungrouping a split folder keeps a page loaded in both windows' panes recoverable", () => {
  const { a, b, group } = splitOnlyFolder("keep");
  const away = S().tabs[splitTabIds(splitsIn(a)[0]).find((id) => S().tabs[id].url === site("one"))];
  const home = S().tabs[splitTabIds(splitsIn(b)[0]).find((id) => S().tabs[id].url === site("one"))];
  const later = `${site("one")}later`;
  useBrowser.setState((st) => ({
    tabs: {
      ...st.tabs,
      [home.id]: { ...home, page: { kind: "loaded", nav: { url: home.url, seq: 3, userInitiated: true } } },
      [away.id]: { ...away, url: later, page: { kind: "loaded", nav: { url: later, seq: 9, userInitiated: true } } },
    },
  }));
  const closed = S().closedTabs.length;
  S().ungroup(folderOf(b, group).id);
  assert.equal(S().tabs[away.id], undefined, "the other window's pane leaves with the split");
  assert.ok(hasPage(S().tabs[home.id]), "the home pane keeps its page");
  assert.deepEqual(S().closedTabs.slice(closed).map((t) => t.tab.url), [later], "the other page can be reopened from Recently Closed");
  assert.ok(S().windows[a]);
  oneCopyInSplitWindows([a, b]);
  S().reopenClosed(a);
  assert.equal(Object.values(S().tabs).filter((t) => t.url === later && hasPage(t)).length, 1, "and reopening it brings the page back, live once");
});

test("without shared tabs, ungrouping a pinned folder keeps its tabs in the invoking window", () => {
  const { b, one, two, group } = windows(false);
  const key = pinKeyOf(S().groups[group]);
  S().ungroup(groupIn(b, key).id);
  for (const id of [one, two]) {
    const copies = rows(b).filter((t) => t.url === `https://${id === one ? "one" : "two"}.example/`);
    assert.equal(copies.length, 1);
    assert.equal(inPinnedContainer(S(), copies[0].id), false);
  }
});

test("shared ungroup ignores matching keys in other profiles and private or small windows", () => {
  const group = (id, windowId, profileId = "default", extra = {}) => ({
    id, windowId, profileId, pinKey: "folder", name: id, icon: null, color: null,
    collapsed: false, pinned: true, tabIds: [], createdAt: 0, ...extra,
  });
  const window = (id, kind, profileId = "default") => ({ id, kind, profileId, tabIds: [], activeTabIds: {}, frame: null, createdAt: 0 });
  let s = {
    settings: { shareTabsAcrossWindows: true }, tabs: {},
    windows: { a: window("a", "main"), b: window("b", "main", "work"), work: window("work", "main", "work"), p: window("p", "private"), small: window("small", "small") },
    groups: { a: group("a", "a"), b: group("b", "b"), work: group("work", "work", "work"), p: group("p", "p"), small: group("small", "small"), list: group("list", "a", "default", { pinned: false }), other: group("other", "a", "default", { pinKey: "other" }) },
  };
  const before = s;
  const slice = createGroupsSlice((change) => { s = { ...s, ...change(s) }; }, () => s, {});
  slice.ungroup("a");
  assert.equal(s.groups.a, undefined);
  assert.equal(s.groups.b, undefined, "a mirror of an inactive profile is still ungrouped");
  for (const id of ["work", "p", "small", "list", "other"]) assert.equal(s.groups[id], before.groups[id], `${id} is untouched`);
  for (const id of ["p", "small", "list", "other"]) {
    s = before;
    slice.ungroup(id);
    assert.equal(s.groups[id], undefined);
    assert.equal(s.groups.a, before.groups.a, "a non-shared source only removes its own container");
    assert.equal(s.groups.b, before.groups.b);
  }
  s = { ...before, groups: { ...before.groups, gone: group("gone", "gone") } };
  slice.ungroup("gone");
  assert.equal(s.groups.gone, undefined, "a group whose window is gone still uses the original fallback");
  assert.equal(s.groups.a, before.groups.a);
});

test("shared ungroup preserves pages and unrelated order across 100 window, owner and profile combinations", () => {
  const cases = [];
  for (const count of [2, 3]) for (const size of [1, 2, 3, 4, 5]) for (const source of [0, 1]) for (const target of [0, 1]) for (const inactive of [false, true]) cases.push({ count, size, source, target, inactive });
  for (const size of [2, 3, 4, 5, 6]) for (const target of [0, 1]) for (const inactive of [false, true]) cases.push({ count: 3, size, source: 2, target, inactive });
  assert.equal(cases.length, 100);
  for (const [index, { count, size, source, target, inactive }] of cases.entries()) {
    S().hydrate({});
    const all = Array.from({ length: count }, (_, n) => S().createWindow({ url: `https://unrelated${n}.example/` }));
    const ids = Array.from({ length: size }, (_, n) => S().newTab(all[n % count], { url: `https://member${n}.example/`, background: true }));
    S().updateSettings({ shareTabsAcrossWindows: true });
    const members = ids.map((id) => rows(all[source]).find((t) => pinKeyOf(t) === id).id);
    const group = S().groupTabs(members, { pinned: true, name: "Reading" });
    const key = pinKeyOf(S().groups[group]);
    const before = Object.fromEntries(ids.map((id) => [id, S().tabs[id].page.nav]));
    const unrelated = all.map((w) => rows(w).filter((t) => !ids.includes(pinKeyOf(t))).map(pinKeyOf));
    if (inactive) {
      const work = S().createProfile({ name: "Work" });
      for (const w of all) S().switchProfile(w, work);
    }
    S().ungroup(groupIn(all[target], key).id);
    for (const w of all) {
      assert.equal(groupIn(w, key), undefined, `case ${index}: the folder is gone`);
      const profileRows = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default");
      assert.deepEqual(profileRows.filter((t) => !ids.includes(pinKeyOf(t))).map(pinKeyOf), unrelated[all.indexOf(w)], `case ${index}: unrelated order is kept`);
      for (const id of ids) assert.equal(profileRows.filter((t) => pinKeyOf(t) === id).length, 1, `case ${index}: each member is listed once`);
      for (const active of Object.values(S().windows[w].activeTabIds)) assert.ok(S().tabs[active], `case ${index}: remembered selections stay valid`);
    }
    keptPages(ids, before);
  }
});
