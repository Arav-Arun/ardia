import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");

const S = () => useBrowser.getState();
const P = "default";
const link = (title, url) => ({ type: "url", title, url });
const folder = (title, children) => ({ type: "folder", title, children });

function tree(id) {
  const node = S().bookmarks.nodes[id];
  if (node.kind === "url") return node.url;
  return [node.title, node.children.map(tree)];
}

const bar = () => tree(bookmarkRoots(S(), P).bar)[1];
const other = () => tree(bookmarkRoots(S(), P).other)[1];

const dia = (bar, others = []) => ({
  type: "folder",
  title: "",
  children: [
    { type: "folder", title: "Bookmarks bar", role: "toolbar", children: bar },
    { type: "folder", title: "Other bookmarks", role: "other", children: others },
  ],
});

const DIA_BAR = [link("Mail", "https://mail.example/"), folder("Work", [link("Docs", "https://docs.example/"), link("Wiki", "https://wiki.example/")])];

function start(...ownLinks) {
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://home.example/" });
  S().addBookmarkTree(P, []);
  for (const [title, url] of ownLinks) S().addBookmark({ profileId: P, title, url });
  takeImportRuns();
}

test("importing the same Dia bookmarks again adds no second Imported from Dia folder (#2389)", () => {
  start(["Mine", "https://mine.example/"]);
  assert.equal(importBookmarks(P, dia(DIA_BAR, [link("Later", "https://later.example/")]), "Dia"), 4);
  const first = { bar: bar(), other: other() };
  assert.deepEqual(first.bar, ["https://mine.example/", ["Imported from Dia", ["https://mail.example/", ["Work", ["https://docs.example/", "https://wiki.example/"]]]]]);
  takeImportRuns();
  for (let run = 0; run < 3; run++) assert.equal(importBookmarks(P, dia(DIA_BAR, [link("Later", "https://later.example/")]), "Dia"), 0);
  assert.deepEqual({ bar: bar(), other: other() }, first, "the bar and Other Bookmarks are unchanged");
  const counts = takeImportRuns();
  assert.equal(counts.import_bookmarks_already_there, 12);
  assert.equal(counts.import_bookmark_folders_reused, 3, "Later went straight into the empty Other Bookmarks, so only the bar has a folder to reuse");
});

test("a repeat import of bookmarks that went straight onto an empty bar adds nothing (#2389)", () => {
  start();
  assert.equal(importBookmarks(P, dia(DIA_BAR), "Dia"), 3);
  const first = bar();
  assert.deepEqual(first, ["https://mail.example/", ["Work", ["https://docs.example/", "https://wiki.example/"]]]);
  assert.equal(importBookmarks(P, dia(DIA_BAR), "Dia"), 0);
  assert.deepEqual(bar(), first);
});

test("a repeat import brings only what's new, into the folders it made, and keeps what the person added or moved (#2389)", () => {
  start(["Mine", "https://mine.example/"]);
  importBookmarks(P, dia(DIA_BAR), "Dia");
  const roots = bookmarkRoots(S(), P);
  const imported = S().bookmarks.nodes[roots.bar].children.find((id) => S().bookmarks.nodes[id].title === "Imported from Dia");
  const work = S().bookmarks.nodes[imported].children.find((id) => S().bookmarks.nodes[id].title === "Work");
  S().addBookmark({ profileId: P, title: "Added by hand", url: "https://by-hand.example/", parentId: work });
  const mail = S().bookmarks.nodes[imported].children.find((id) => S().bookmarks.nodes[id].kind === "url");
  S().moveBookmark(mail, roots.other);
  const grown = [...DIA_BAR, link("News", "https://news.example/")];
  grown[1] = folder("Work", [...DIA_BAR[1].children, link("Plan", "https://plan.example/")]);
  assert.equal(importBookmarks(P, dia(grown), "Dia"), 2);
  assert.deepEqual(bar(), [
    "https://mine.example/",
    ["Imported from Dia", [["Work", ["https://docs.example/", "https://wiki.example/", "https://by-hand.example/", "https://plan.example/"]], "https://news.example/"]],
  ]);
  assert.deepEqual(other(), ["https://mail.example/"], "a bookmark moved out of the import isn't brought back");
});

test("an import from another browser still gets its own folder, and leaves out only the pages the profile already has", () => {
  start(["Mine", "https://mine.example/"]);
  importBookmarks(P, dia(DIA_BAR), "Dia");
  assert.equal(importBookmarks(P, dia([link("Docs", "https://DOCS.example/#"), link("Chrome only", "https://chrome.example/")]), "Chrome"), 1);
  assert.deepEqual(bar().at(-1), ["Imported from Chrome", ["https://chrome.example/"]]);
  assert.equal(bar().filter((n) => Array.isArray(n) && n[0] === "Imported from Dia").length, 1);
});

test("the source's own repeated links and empty folders still come over on a first import", () => {
  start();
  const twice = [link("A", "https://a.example/"), folder("Again", [link("A", "https://a.example/")]), folder("Empty", [])];
  assert.equal(importBookmarks(P, dia(twice), "Dia"), 2);
  assert.deepEqual(bar(), ["https://a.example/", ["Again", ["https://a.example/"]], ["Empty", []]]);
  assert.equal(importBookmarks(P, dia(twice), "Dia"), 0);
  assert.equal(bar().length, 3);
});
