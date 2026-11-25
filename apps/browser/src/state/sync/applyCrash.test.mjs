import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { historyOf } = await import("../history/history.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { bookmarksAdapter } = await import("./adapters.ts");
const { historyAdapter, historyExpired } = await import("./historyAdapter.ts");
const { useEditClock } = await import("./editClock.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const SAVE_MS = 30_000;

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (_scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, payload);
        return id;
      },
      read: async (_scope, known) => {
        const files = [...this.files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload }));
        return { files, pending: [], damaged: [], present: [...this.files.keys()] };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

class Mac {
  constructor(id, folder) {
    this.id = id;
    this.folder = folder;
    S().hydrate({});
    useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } }, bookmarksReady: { "": true } });
    this.browser = S();
    this.state = emptyScope();
    this.clock = new Clock(id);
    this.saved = [];
    this.launches = 0;
    this.launch = `${id}-0`;
    this.steady = 0;
    this.chromeSaves();
  }
  with(fn) {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  chromeSaves() {
    this.disk = { bookmarks: this.browser.bookmarks, history: this.browser.history };
  }
  killed() {
    this.browser = { ...this.browser, ...this.disk };
    const last = this.saved.map((s) => s.kind).lastIndexOf("state");
    this.state = last >= 0 ? JSON.parse(this.saved[last].json) : emptyScope();
    for (const later of this.saved.slice(last + 1)) {
      const batch = JSON.parse(later.json);
      this.state.applying = [...(this.state.applying ?? []).filter((b) => b.id !== batch.id), batch];
    }
    this.clock = new Clock(this.id, this.clock.last);
    this.launch = `${this.id}-${++this.launches}`;
    this.steady = 0;
  }
  async sync() {
    this.steady += 1_000;
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      const result = await syncScope({
        scope: "p",
        state: this.state,
        transport: this.folder.transport(),
        adapters: [bookmarksAdapter("default"), historyAdapter("default")],
        clock: this.clock,
        device: this.id,
        options: {
          expired: historyExpired,
          persistApplying: async (batch) => void this.saved.push({ kind: "batch", json: JSON.stringify(batch) }),
          launch: this.launch,
          nativeSaveMs: SAVE_MS,
          monotonic: () => this.steady,
        },
      });
      this.saved.push({ kind: "state", json: JSON.stringify(this.state) });
      return result;
    } finally {
      this.browser = S();
    }
  }
}

async function syncAll(macs, rounds = 2) {
  for (let i = 0; i < rounds; i++) for (const mac of macs) await mac.sync();
}

function titles(mac) {
  return mac.with(() => {
    const roots = bookmarkRoots(S(), "default");
    const b = S().bookmarks;
    return [roots.bar, roots.other].map((root) => b.nodes[root].children.map((id) => b.nodes[id].title));
  });
}

const idOf = (mac, title) => mac.with(() => Object.values(S().bookmarks.nodes).find((n) => n.title === title)?.id);

async function savedPair() {
  const folder = new Folder();
  const a = new Mac("devA", folder);
  const p = new Mac("devP", folder);
  return { folder, a, p };
}

async function settled(a, p) {
  await syncAll([a, p], 2);
  a.chromeSaves();
  p.chromeSaves();
  a.steady += SAVE_MS + 1;
  p.steady += SAVE_MS + 1;
  await syncAll([a, p], 1);
}

test("bookmarks: renamed and moved first on one Mac, applied and killed before Chrome saved on the other, then deleted: it stays deleted", async () => {
  const { a, p } = await savedPair();
  a.with(() => {
    S().addBookmark({ profileId: "default", url: "https://x.example/", title: "X" });
    S().addBookmark({ profileId: "default", url: "https://b.example/", title: "B" });
  });
  await settled(a, p);
  assert.deepEqual(titles(p), titles(a));
  a.with(() => {
    const id = idOf(a, "B");
    S().updateBookmark(id, { title: "B renamed" });
    S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 0);
  });
  await a.sync();
  await p.sync();
  assert.deepEqual(titles(p), titles(a));
  p.killed();
  a.with(() => S().removeBookmark(idOf(a, "B renamed")));
  await a.sync();
  await syncAll([p, a], 3);
  const left = titles(a).flat();
  assert.deepEqual(left, ["X"]);
  assert.deepEqual(titles(p), titles(a));
});

test("bookmarks: a reorder applied and killed before Chrome saved isn't undone on the other Mac", async () => {
  const { a, p } = await savedPair();
  a.with(() => {
    S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
    S().addBookmark({ profileId: "default", url: "https://two.example/", title: "Two" });
    S().addBookmark({ profileId: "default", url: "https://three.example/", title: "Three" });
  });
  await settled(a, p);
  const before = titles(a);
  a.with(() => {
    const id = idOf(a, "One");
    S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 3);
  });
  await a.sync();
  await p.sync();
  a.chromeSaves();
  p.chromeSaves();
  a.steady += SAVE_MS + 1;
  p.steady += SAVE_MS + 1;
  await syncAll([a, p], 1);
  const settledOrder = titles(a);
  a.with(() => {
    const id = idOf(a, "Three");
    S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 0);
  });
  await a.sync();
  await p.sync();
  const reordered = titles(a);
  assert.notDeepEqual(reordered, settledOrder);
  assert.notDeepEqual(settledOrder, before);
  assert.deepEqual(titles(p), reordered);
  p.killed();
  assert.deepEqual(titles(p), settledOrder);
  assert.equal((await p.sync()).published, 0, "the stale order isn't sent as this Mac's edit");
  await syncAll([p, a], 3);
  assert.deepEqual(titles(a), reordered);
  assert.deepEqual(titles(p), reordered);
});

test("history: visits applied and killed before Chrome committed them are applied again after the restart", async () => {
  const { a, p } = await savedPair();
  const url = "https://visited.example/";
  const first = Date.now() - 60_000;
  const second = Date.now() - 30_000;
  const visit = (times) => ({ url, title: "Visited", favicon: null, visits: times.length, lastVisit: times.at(-1), visitTimes: times });
  a.with(() => useBrowser.setState({ history: { "": { list: [visit([first])], floor: -Infinity, ready: true } } }));
  await settled(a, p);
  const timesOn = (mac) => mac.with(() => historyOf(S(), "default").find((e) => e.url === url)?.visitTimes);
  assert.deepEqual(timesOn(p), [first]);
  a.with(() => useBrowser.setState({ history: { "": { list: [visit([first, second])], floor: -Infinity, ready: true } } }));
  await a.sync();
  await p.sync();
  assert.deepEqual(timesOn(p), [first, second]);
  p.killed();
  assert.deepEqual(timesOn(p), [first]);
  await syncAll([p, a], 2);
  assert.deepEqual(timesOn(p), [first, second]);
  assert.deepEqual(timesOn(a), [first, second]);
});
