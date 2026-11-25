import assert from "node:assert/strict";
import { mock, test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { INDEX_WHEN_QUIET_MS, reloadHistory, startHistory } = await import("./engineSync.ts");
const { historyListIndexed } = await import("./historyChanges.ts");
const { setQuitting } = await import("../app/quit.ts");
const { markProfileUnloaded, openProfile } = await import("../profiles/profileLoading.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const PROFILES = {
  default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
  work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 },
};
const listOf = (engine) => S().history[engine]?.list ?? [];
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

async function started() {
  mock.timers.enable({ apis: ["setTimeout"] });
  S().hydrate({ profiles: PROFILES, profileOrder: ["default", "work"] });
  stub.docs.clear();
  stub.historyDbs.clear();
  for (const engine of ["", "work"]) openProfile(engine);
  const now = Date.now();
  for (const engine of ["", "work"]) {
    const db = stub.chromeHistory(engine);
    for (let i = 0; i < 50; i++) db.set(`https://${engine || "home"}${i}.example/`, { title: `P${i}`, visits: [now - 60_000 - i * 1000] });
  }
  const stop = startHistory();
  await reloadHistory();
  await settle();
  return stop;
}

const visit = (engine, i) => stub.chromeVisit(engine, `https://visit${i}.example/`, `V${i}`, Date.now() + i);

const finish = (stop) => {
  stop();
  setQuitting(false);
  mock.timers.reset();
};

test("a profile's list is indexed once its history has been quiet for 2 s, not before", async () => {
  const stop = await started();
  try {
    visit("", 1);
    await settle();
    const list = listOf("");
    assert.equal(historyListIndexed(list), false);
    mock.timers.tick(INDEX_WHEN_QUIET_MS - 1);
    assert.equal(historyListIndexed(list), false, "not before the quiet time");
    mock.timers.tick(1);
    assert.equal(historyListIndexed(list), true);
  } finally {
    finish(stop);
  }
});

test("two profiles changed in the same batch each get their own index", async () => {
  const stop = await started();
  try {
    visit("", 1);
    visit("work", 2);
    await settle();
    const home = listOf("");
    const work = listOf("work");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(home), true, "Personal");
    assert.equal(historyListIndexed(work), true, "Work");
  } finally {
    finish(stop);
  }
});

test("clearing a profile's history drops the build pending for the list it replaced", async () => {
  const stop = await started();
  try {
    visit("", 1);
    await settle();
    const before = listOf("");
    S().clearHistory("default");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(before), false, "the replaced list is never indexed");
    assert.equal(historyListIndexed(listOf("")), false, "and nothing is built for the cleared one");
  } finally {
    finish(stop);
  }
});

test("stopping history sync drops every pending build", async () => {
  const stop = await started();
  visit("", 1);
  visit("work", 2);
  await settle();
  const home = listOf("");
  const work = listOf("work");
  finish(stop);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(home), false);
    assert.equal(historyListIndexed(work), false);
  } finally {
    mock.timers.reset();
  }
});

test("a profile unloaded while its build is pending isn't indexed; the other profile still is", async () => {
  const stop = await started();
  try {
    visit("", 1);
    visit("work", 2);
    await settle();
    const home = listOf("");
    const work = listOf("work");
    markProfileUnloaded("work");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(work), false, "unloaded");
    assert.equal(historyListIndexed(home), true, "still loaded");
  } finally {
    finish(stop);
  }
});

test("once quitting starts nothing pending is built, and a batch during the quit schedules nothing", async () => {
  const stop = await started();
  try {
    visit("", 1);
    await settle();
    const before = listOf("");
    setQuitting(true);
    visit("work", 2);
    await settle();
    const during = listOf("work");
    mock.timers.tick(INDEX_WHEN_QUIET_MS);
    assert.equal(historyListIndexed(before), false);
    assert.equal(historyListIndexed(during), false);
  } finally {
    finish(stop);
  }
});
