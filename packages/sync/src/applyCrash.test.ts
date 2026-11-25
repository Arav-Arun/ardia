import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock } from "./hlc.ts";
import { syncScope } from "./scope.ts";
import { emptyScope, type Adapter, type Applying, type Listing, type ScopeState, type Transport } from "./scopeState.ts";

const SAVE_MS = 30_000;

class Folder {
  files = new Map<string, string>();
  counter = 0;
  now = 1_000_000;
  transport(): Transport {
    return {
      write: async (_scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, payload);
        return id;
      },
      read: async (_scope, known): Promise<Listing> => {
        const listing: Listing = { files: [], pending: [], damaged: [], present: [] };
        for (const [id, payload] of this.files) {
          listing.present.push(id);
          if (!known.includes(id)) listing.files.push({ id, payload });
        }
        return listing;
      },
      remove: async (_scope, ids) => {
        for (const id of ids) this.files.delete(id);
      },
    };
  }
}

type Saved = { kind: "state"; json: string; clock: string | null } | { kind: "applying"; json: string };

class Mac {
  memory = new Map<string, unknown>();
  disk = new Map<string, unknown>();
  state: ScopeState = emptyScope();
  clock: Clock;
  launches = 0;
  launch: string;
  writeAhead: boolean;
  saved: Saved[] = [];
  readonly id: string;
  readonly folder: Folder;
  constructor(id: string, folder: Folder, writeAhead = true) {
    this.id = id;
    this.folder = folder;
    this.writeAhead = writeAhead;
    this.clock = new Clock(id, null, () => folder.now);
    this.launch = `${id}-0`;
  }
  adapter(): Adapter {
    return {
      prefix: "b:",
      extract: () => ({ values: new Map(this.memory) }),
      apply: (visible, changed) => {
        for (const key of changed) visible.has(key) ? this.memory.set(key, visible.get(key)) : this.memory.delete(key);
      },
    };
  }
  chromeSaves() {
    this.disk = new Map(this.memory);
  }
  async sync() {
    const persistApplying = this.writeAhead
      ? async (applying: Record<string, Applying>) => void this.saved.push({ kind: "applying", json: JSON.stringify(applying) })
      : undefined;
    const result = await syncScope({
      scope: "s",
      state: this.state,
      transport: this.folder.transport(),
      adapters: [this.adapter()],
      clock: this.clock,
      device: this.id,
      now: () => this.folder.now,
      options: { pruneGrace: 0, persist: async () => {}, persistApplying, launch: this.launch, nativeSaveMs: SAVE_MS },
    });
    this.saved.push({ kind: "state", json: JSON.stringify(this.state), clock: this.clock.last });
    return result;
  }
  killed() {
    this.memory = new Map(this.disk);
    const last = this.saved.map((s) => s.kind).lastIndexOf("state");
    const state = last >= 0 ? (this.saved[last] as Extract<Saved, { kind: "state" }>) : null;
    this.state = state ? (JSON.parse(state.json) as ScopeState) : emptyScope();
    for (const later of this.saved.slice(last + 1)) if (later.kind === "applying") this.state.applying = JSON.parse(later.json) as Record<string, Applying>;
    this.clock = new Clock(this.id, state?.clock ?? null, () => this.folder.now);
    this.launch = `${this.id}-${++this.launches}`;
  }
}

const settle = async (folder: Folder, macs: Mac[], rounds = 3) => {
  for (let i = 0; i < rounds; i++) {
    for (const mac of macs) {
      folder.now += 1_000;
      await mac.sync();
    }
  }
};

async function pairWith(bookmarks: Record<string, string>, writeAhead = true) {
  const folder = new Folder();
  const a = new Mac("macA", folder, writeAhead);
  const b = new Mac("macB", folder, writeAhead);
  for (const [key, title] of Object.entries(bookmarks)) a.memory.set(key, title);
  await settle(folder, [a, b]);
  a.chromeSaves();
  b.chromeSaves();
  folder.now += SAVE_MS + 1;
  await settle(folder, [a, b]);
  return { folder, a, b };
}

const view = (mac: Mac) => Object.fromEntries([...mac.memory].sort(([x], [y]) => x.localeCompare(y)));

test("a bookmark deleted on another Mac stays deleted after this Mac is killed before Chrome saved the rename it applied", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "T1", "b:t2": "T2" });
  a.memory.set("b:t1", "T1 renamed");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  assert.equal(b.memory.get("b:t1"), "T1 renamed");
  b.killed();
  assert.equal(b.memory.get("b:t1"), "T1");
  a.memory.delete("b:t1");
  folder.now += 1_000;
  await a.sync();
  folder.now += 60_000;
  await settle(folder, [b, a], 4);
  assert.deepEqual(view(a), { "b:t2": "T2" });
  assert.deepEqual(view(b), { "b:t2": "T2" });
});

test("a bookmark added on another Mac isn't deleted everywhere when this Mac is killed before Chrome saved it", async () => {
  const { folder, a, b } = await pairWith({ "b:t2": "T2" });
  a.memory.set("b:new", "New");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  b.killed();
  assert.equal(b.memory.has("b:new"), false);
  folder.now += 60_000;
  const { reapplied } = await b.sync();
  assert.equal(reapplied, 1);
  await settle(folder, [a, b], 3);
  assert.deepEqual(view(a), { "b:new": "New", "b:t2": "T2" });
  assert.deepEqual(view(b), { "b:new": "New", "b:t2": "T2" });
});

test("without the write-ahead intent the same crash republishes the stale rename", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "T1" }, false);
  a.memory.set("b:t1", "T1 renamed");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  b.killed();
  a.memory.delete("b:t1");
  folder.now += 1_000;
  await a.sync();
  folder.now += 60_000;
  await settle(folder, [b, a], 4);
  assert.equal(a.memory.get("b:t1"), "T1");
});

test("an edit made offline after the crash still wins over the recovery", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "T1" });
  a.memory.set("b:t1", "T1 renamed");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  b.killed();
  folder.now += 60_000;
  b.memory.set("b:t1", "B's own title");
  await settle(folder, [b, a], 3);
  assert.equal(a.memory.get("b:t1"), "B's own title");
  assert.equal(b.memory.get("b:t1"), "B's own title");
});

test("a second kill during recovery, before Chrome saved the re-apply, still recovers", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "T1", "b:t2": "T2" });
  a.memory.set("b:t1", "T1 renamed");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  b.killed();
  folder.now += 60_000;
  await b.sync();
  assert.equal(b.memory.get("b:t1"), "T1 renamed");
  b.killed();
  assert.equal(b.memory.get("b:t1"), "T1");
  a.memory.delete("b:t2");
  folder.now += 1_000;
  await a.sync();
  folder.now += 60_000;
  await settle(folder, [b, a], 4);
  assert.deepEqual(view(a), { "b:t1": "T1 renamed" });
  assert.deepEqual(view(b), { "b:t1": "T1 renamed" });
});

test("a Mac killed after Chrome saved takes the applied value as its own base and publishes nothing", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "T1" });
  a.memory.set("b:t1", "T1 renamed");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  b.chromeSaves();
  b.killed();
  folder.now += 60_000;
  const { published, reapplied } = await b.sync();
  assert.equal(published, 0);
  assert.equal(reapplied, 0);
});

test("the intent clears once Chrome's save window has passed in the same launch", async () => {
  const { folder, a, b } = await pairWith({ "b:t1": "T1" });
  a.memory.set("b:t1", "T1 renamed");
  folder.now += 1_000;
  await a.sync();
  folder.now += 1_000;
  await b.sync();
  assert.ok(b.state.applying?.["b:t1"]);
  assert.ok(b.saved.some((s) => s.kind === "applying"));
  folder.now += SAVE_MS;
  await b.sync();
  assert.equal(b.state.applying, undefined);
});
