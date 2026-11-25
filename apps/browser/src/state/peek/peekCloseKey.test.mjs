import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
const { takePeekMotionCounts } = await import("../telemetry/peekMotion.ts");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("../commands/commands.ts");
const { openFind } = await import("../find/actions.ts");
const { activeTabId } = await import("../browser/model.ts");
const { shownPeek } = await import("./peek.ts");
const { webviews } = await import("../../platform/webviews.ts");
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const windowWithPeek = () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const a = S().windows[w].tabIds[0];
  S().newTab(w, { url: "https://b.example/", background: true });
  S().activate(a);
  const peek = S().openPeek(a, "https://peek.example/page", { x: 100, y: 200 });
  assert.ok(peek && shownPeek(S(), w), "a Peek shows");
  return { w, a, peek };
};

test("⌘W in a Peek with Find open closes the Peek, as File › Close Peek says, not just the Find bar", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takePeekMotionCounts();
  const { w, a, peek } = windowWithPeek();
  const focused = [];
  webviews.set(peek, { focus: async () => void focused.push(peek), stopFinding: async () => {} });
  openFind(peek);
  assert.equal(S().find[peek].open, true);
  runCommand({ command: "closeTab", arg: null, windowId: w }, { user: { consent: client.consentToken() } });
  await settle();
  assert.equal(shownPeek(S(), w), undefined, "the Peek is gone");
  assert.notEqual(S().find[peek]?.open, true, "its Find bar went with it");
  assert.deepEqual(focused, [], "the closing Peek's page isn't handed the keyboard");
  assert.ok(S().tabs[a], "the page under the Peek stays");
  assert.equal(activeTabId(S(), w), a);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 1, "the completed close is counted once");
});

test("⌘W in a Peek without Find still closes the Peek, and the tab under it stays", async () => {
  const { w, a } = windowWithPeek();
  runCommand({ command: "closeTab", arg: null, windowId: w });
  await settle();
  assert.equal(shownPeek(S(), w), undefined);
  assert.ok(S().tabs[a]);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0, "a close without Find isn't counted");
});

test("with sharing off, a ⌘W close with Find open isn't counted", async () => {
  client.setSharing(false, "settings");
  takePeekMotionCounts();
  const { w, peek } = windowWithPeek();
  webviews.set(peek, { focus: async () => {}, stopFinding: async () => {} });
  openFind(peek);
  runCommand({ command: "closeTab", arg: null, windowId: w }, { user: { consent: client.consentToken() } });
  await settle();
  assert.equal(shownPeek(S(), w), undefined);
  assert.equal(takePeekMotionCounts().peek_close_key_closes_with_find, 0);
});

test("⌘W in a tab with Find open closes the tab", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().newTab(w, { url: "https://b.example/" });
  openFind(b);
  runCommand({ command: "closeTab", arg: null, windowId: w });
  await settle();
  assert.equal(S().tabs[b], undefined);
});
