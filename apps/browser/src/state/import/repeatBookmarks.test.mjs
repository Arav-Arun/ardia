import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");
const { pageKey } = await import("../tabs/pageKeys.ts");
const { engineProfile } = await import("../browser/model.ts");

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
  stub.docs.delete("imported-bookmarks.json");
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
  assert.equal(counts.import_bookmark_folders_reused, 0, "an import that adds nothing reuses no folder");
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

const childNamed = (parentId, title) => S().bookmarks.nodes[parentId].children.find((id) => S().bookmarks.nodes[id].title === title);
const barId = () => bookmarkRoots(S(), P).bar;

test("two folders of the same name each take their own new links, matched by the links they share", () => {
  start(["Mine", "https://mine.example/"]);
  const nested = (extraA = [], extraB = []) => [folder("Top", [folder("Same", [link("A", "https://a.example/"), ...extraA]), folder("Same", [link("B", "https://b.example/"), ...extraB])])];
  importBookmarks(P, dia(nested()), "Dia");
  assert.equal(importBookmarks(P, dia(nested([link("A2", "https://a2.example/")], [link("B2", "https://b2.example/")])), "Dia"), 2);
  assert.deepEqual(bar()[1], ["Imported from Dia", [["Top", [["Same", ["https://a.example/", "https://a2.example/"]], ["Same", ["https://b.example/", "https://b2.example/"]]]]]]);
});

test("a folder that went straight onto the bar keeps taking its new links after a later import made an Imported from folder", () => {
  start();
  const work = (...more) => folder("Work", [link("Docs", "https://docs.example/"), link("Wiki", "https://wiki.example/"), ...more]);
  importBookmarks(P, dia([work()]), "Dia");
  importBookmarks(P, dia([work(link("Plan", "https://plan.example/")), link("News", "https://news.example/")]), "Dia");
  importBookmarks(P, dia([work(link("Plan", "https://plan.example/"), link("Ship", "https://ship.example/")), link("News", "https://news.example/")]), "Dia");
  assert.deepEqual(bar(), [
    ["Work", ["https://docs.example/", "https://wiki.example/", "https://plan.example/", "https://ship.example/"]],
    ["Imported from Dia", ["https://news.example/"]],
  ]);
});

test("another browser's folder that shares a link with one an earlier import put on the bar gets its own Imported from folder", () => {
  start();
  importBookmarks(P, dia([folder("Work", [link("Docs", "https://docs.example/"), link("Wiki", "https://wiki.example/")])]), "Dia");
  assert.equal(importBookmarks(P, dia([folder("Work", [link("Docs", "https://docs.example/"), link("Chrome", "https://chrome.example/"), link("Mail", "https://mail.example/")])]), "Chrome"), 2);
  assert.deepEqual(bar(), [
    ["Work", ["https://docs.example/", "https://wiki.example/"]],
    ["Imported from Chrome", [["Work", ["https://chrome.example/", "https://mail.example/"]]]],
  ]);
});

test("folders with no links come over: on a first import, and as a new folder in a repeat whose links are all there", () => {
  start();
  assert.equal(importBookmarks(P, dia([folder("Empty", []), folder("Also empty", [])]), "Dia"), 0);
  assert.deepEqual(bar(), [["Empty", []], ["Also empty", []]]);
  assert.equal(importBookmarks(P, dia([folder("Empty", []), folder("Also empty", [])]), "Dia"), 0);
  assert.equal(bar().length, 2, "and aren't made twice");
  start(["Mine", "https://mine.example/"]);
  importBookmarks(P, dia(DIA_BAR), "Dia");
  importBookmarks(P, dia([...DIA_BAR, folder("Ideas", [])]), "Dia");
  assert.deepEqual(bar()[1][1].at(-1), ["Ideas", []]);
  importBookmarks(P, dia([...DIA_BAR, folder("Ideas", [])]), "Dia");
  assert.equal(bar()[1][1].filter((n) => Array.isArray(n) && n[0] === "Ideas").length, 1);
});

test("a link with the scheme's default port is the page already bookmarked without it", () => {
  start(["Port", "https://port.example/"], ["Plain", "http://plain.example/a"]);
  assert.equal(importBookmarks(P, dia([link("Port", "https://port.example:443/"), link("Plain", "HTTP://Plain.Example:80/a"), link("Other port", "https://port.example:8443/")]), "Dia"), 1);
  assert.deepEqual(bar().at(-1), ["Imported from Dia", ["https://port.example:8443/"]]);
});

test("a repeat import that adds one link to each of 1,500 folders writes the store once", () => {
  start(["Mine", "https://mine.example/"]);
  const folders = (extra) => Array.from({ length: 1500 }, (_, i) => folder(`F${i}`, [link("a", `https://f${i}.example/a`), ...(extra ? [link("b", `https://f${i}.example/b`)] : [])]));
  importBookmarks(P, dia(folders(false)), "Dia");
  let writes = 0;
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.bookmarks !== prev.bookmarks) writes += 1;
  });
  const began = performance.now();
  assert.equal(importBookmarks(P, dia(folders(true)), "Dia"), 1500);
  const took = performance.now() - began;
  stop();
  assert.equal(writes, 1);
  assert.ok(took < 2000, `took ${took} ms`);
  const wrapper = childNamed(barId(), "Imported from Dia");
  assert.equal(S().bookmarks.nodes[wrapper].children.length, 1500, "every folder took its link in place");
});

test("Imported from folders reused counts each import that added to a folder an earlier one made, and no other", () => {
  start(["Mine", "https://mine.example/"]);
  importBookmarks(P, dia(DIA_BAR), "Dia");
  takeImportRuns();
  importBookmarks(P, dia(DIA_BAR), "Dia");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0, "nothing added");
  importBookmarks(P, dia([...DIA_BAR, link("News", "https://news.example/")]), "Dia");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1, "added to Imported from Dia");
  start();
  importBookmarks(P, dia(DIA_BAR), "Dia");
  takeImportRuns();
  importBookmarks(P, dia([DIA_BAR[0], folder("Work", [...DIA_BAR[1].children, link("Plan", "https://plan.example/")])]), "Dia");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1, "added to a folder an earlier import put straight on the bar");
  importBookmarks(P, dia([link("Fresh", "https://fresh.example/")]), "Chrome");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0, "a new Imported from folder isn't a reused one");
});

test("another browser's folder that went straight onto the bar never takes a Dia import, even when Dia's folder holds all its links", () => {
  start();
  importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Chrome");
  assert.equal(importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar(), [
    ["Work", ["https://a.example/"]],
    ["Imported from Dia", [["Work", ["https://b.example/"]]]],
  ]);
});

test("an empty folder an import put on the bar takes the links the source adds to it later", () => {
  start();
  importBookmarks(P, dia([folder("Work", []), link("Mail", "https://mail.example/")]), "Dia");
  assert.equal(importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")]), link("Mail", "https://mail.example/")]), "Dia"), 1);
  assert.deepEqual(bar(), [["Work", ["https://a.example/"]], "https://mail.example/"]);
  start(["Mine", "https://mine.example/"]);
  importBookmarks(P, dia([folder("Later", [])]), "Dia");
  importBookmarks(P, dia([folder("Later", [link("Read", "https://read.example/")])]), "Dia");
  assert.deepEqual(bar()[1], ["Imported from Dia", [["Later", ["https://read.example/"]]]]);
});

test("which folders an import made is saved, so a relaunch keeps matching them", () => {
  start();
  importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Dia");
  const saved = JSON.parse(stub.docs.get("imported-bookmarks.json"));
  const work = childNamed(barId(), "Work");
  assert.deepEqual(saved.folders[work], { source: "Dia", engine: engineProfile(S(), P) });
  assert.equal(saved.version, 1);
  const nodes = structuredClone(S().bookmarks.nodes);
  useBrowser.setState({ bookmarks: { nodes } });
  importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia");
  assert.deepEqual(bar(), [["Work", ["https://a.example/", "https://b.example/"]]]);
});

test("folders of the same name are matched as a whole, so one that shares a link with both doesn't take the other's", () => {
  start(["Mine", "https://mine.example/"]);
  importBookmarks(P, dia([folder("Same", [link("Shared", "https://shared.example/"), link("A", "https://a.example/")]), folder("Same", [link("Shared", "https://shared.example/"), link("B", "https://b.example/")])]), "Dia");
  importBookmarks(P, dia([folder("Same", [link("Shared", "https://shared.example/"), link("New B", "https://new-b.example/")]), folder("Same", [link("A", "https://a.example/"), link("New A", "https://new-a.example/")])]), "Dia");
  assert.deepEqual(bar()[1], [
    "Imported from Dia",
    [
      ["Same", ["https://shared.example/", "https://a.example/", "https://new-a.example/"]],
      ["Same", ["https://shared.example/", "https://b.example/", "https://new-b.example/"]],
    ],
  ]);
});

test("3,000 folders of the same name each take their own new link, in one store write", () => {
  start(["Mine", "https://mine.example/"]);
  const siblings = (extra) => Array.from({ length: 3000 }, (_, i) => folder("Folder", [link("a", `https://s${i}.example/a`), ...(extra ? [link("b", `https://s${i}.example/b`)] : [])]));
  importBookmarks(P, dia(siblings(false)), "Dia");
  let writes = 0;
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.bookmarks !== prev.bookmarks) writes += 1;
  });
  const began = performance.now();
  assert.equal(importBookmarks(P, dia(siblings(true)), "Dia"), 3000);
  const took = performance.now() - began;
  stop();
  assert.equal(writes, 1);
  assert.ok(took < 3000, `took ${took} ms`);
  const wrapper = childNamed(barId(), "Imported from Dia");
  const nodes = S().bookmarks.nodes;
  assert.equal(nodes[wrapper].children.length, 3000);
  assert.ok(nodes[wrapper].children.every((id, i) => nodes[id].children.map((c) => nodes[c].url).join(" ") === `https://s${i}.example/a https://s${i}.example/b`));
});

test("a port written with leading zeros is the scheme's default port, or the same port without them", () => {
  assert.equal(pageKey("https://Port.example:0443/"), "https://port.example/");
  assert.equal(pageKey("http://port.example:080/x"), "http://port.example/x");
  assert.equal(pageKey("https://port.example:08443/"), "https://port.example:8443/");
  assert.equal(pageKey("https://port.example:/"), "https://port.example/");
  assert.equal(pageKey("https://user:Pw@[::1]:0443/"), "https://user:Pw@[::1]/");
  start(["Port", "https://port.example/"], ["Other", "https://port.example:8443/"]);
  assert.equal(importBookmarks(P, dia([link("Port", "https://port.example:0443/"), link("Other", "https://port.example:08443/")]), "Dia"), 0);
});

test("a folder someone named Imported from Dia by hand takes the import but isn't counted as one an import made, and an added empty folder counts", () => {
  start();
  S().addBookmarkFolder({ profileId: P, title: "Imported from Dia" });
  takeImportRuns();
  importBookmarks(P, dia([link("A", "https://a.example/")]), "Dia");
  assert.deepEqual(bar(), [["Imported from Dia", ["https://a.example/"]]]);
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0);
  importBookmarks(P, dia([link("A", "https://a.example/"), folder("Ideas", [])]), "Dia");
  assert.deepEqual(bar(), [["Imported from Dia", ["https://a.example/", ["Ideas", []]]]]);
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1, "an import made into the folder it now owns");
});
