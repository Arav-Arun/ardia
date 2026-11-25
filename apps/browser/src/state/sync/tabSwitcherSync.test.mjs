import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { useEditClock } = await import("./editClock.ts");
const { settingsAdapter } = await import("./settingsAdapter.ts");

const S = () => useBrowser.getState();
const STEP = { nextTab: ["\t", "control"], previousTab: ["\t", "control", "shift"] };
const SWITCHER = { "tabSwitcher:forward": ["\t", "control"], "tabSwitcher:backward": ["\t", "control", "shift"] };

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        const shown = [...this.files].filter(([, f]) => f.scope === scope);
        return { files: shown.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: shown.map(([id]) => id) };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

const publishing = (values) => ({ prefix: "set:", extract: () => ({ values: new Map(Object.entries(values()).map(([k, v]) => [`set:${k}`, { v }])), ignore: (key) => !(key.slice(4) in values()) }), apply: () => {} });

class Peer {
  constructor(id, folder, values) {
    this.id = id;
    this.folder = folder;
    this.values = values;
    this.scope = emptyScope();
    this.clock = new Clock(id);
  }
  set(values) {
    this.values = values;
  }
  async sync() {
    useEditClock(this.clock);
    await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: [publishing(() => this.values)], clock: this.clock, device: this.id });
  }
}

class Device {
  constructor(id, folder) {
    this.id = id;
    this.folder = folder;
    S().hydrate({});
    this.browser = S();
    this.scope = emptyScope();
    this.clock = new Clock(id);
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
  async sync() {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: [settingsAdapter], clock: this.clock, device: this.id });
    } finally {
      this.browser = S();
    }
  }
  modes() {
    return this.with(() => ({ tabSwitcherOrder: S().settings.tabSwitcherOrder, tabSwitcherView: S().settings.tabSwitcherView }));
  }
  published() {
    return this.with(() => Object.fromEntries([...settingsAdapter.extract(() => undefined).values].filter(([key]) => key.startsWith("set:tabSwitcher")).map(([key, record]) => [key.slice(4), record.v])));
  }
}

test("a Compact list chosen here survives a legacy stepping record and a later Recent tabs record, and is never published as None", async () => {
  const run = async (together) => {
    const folder = new Folder();
    const device = new Device("B", folder);
    device.with(() => S().updateSettings({ tabSwitcherView: "compactList" }));
    const legacy = new Peer("old", folder, { shortcuts: STEP });
    const newer = new Peer("new", folder, { tabSwitcherOrder: "recent" });
    await legacy.sync();
    if (together) await newer.sync();
    await device.sync();
    if (!together) {
      await newer.sync();
      await device.sync();
    }
    return { modes: device.modes(), published: device.published() };
  };
  const separate = await run(false);
  assert.deepEqual(separate.modes, { tabSwitcherOrder: "recent", tabSwitcherView: "compactList" });
  assert.notEqual(separate.published.tabSwitcherView, "none");
  assert.equal(separate.published.tabSwitcherView, "compactList");
  assert.deepEqual(separate.modes, (await run(true)).modes, "the same as both records in one pull");
});

test("with no mode records, a legacy peer switching from stepping back to the recent tabs switcher ends the same in one pull or two", async () => {
  const run = async (separately) => {
    const folder = new Folder();
    const device = new Device("B", folder);
    const legacy = new Peer("old", folder, { shortcuts: STEP });
    await legacy.sync();
    if (separately) {
      await device.sync();
      assert.deepEqual(device.modes(), { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" }, "stepping is inferred first");
    }
    legacy.set({ shortcuts: SWITCHER });
    await legacy.sync();
    await device.sync();
    return { modes: device.modes(), shortcuts: device.with(() => S().settings.shortcuts) };
  };
  const separate = await run(true);
  assert.deepEqual(separate.modes, { tabSwitcherOrder: "recent", tabSwitcherView: "thumbnails" });
  assert.deepEqual(separate, await run(false));
});
