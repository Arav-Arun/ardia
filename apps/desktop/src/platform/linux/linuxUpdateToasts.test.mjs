import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import { UPDATE_PREFERENCES } from "./hostUpdates.ts";
import { setConsentPeriod } from "../../../../browser/src/state/telemetry/consentPeriod.ts";
import { takeUpdateCounts } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { useToasts } from "../../../../browser/src/state/app/toasts.ts";
import { mount } from "../../../../browser/src/test-hooks.mjs";

const entry = new URL("./linuxUpdates.ts", import.meta.url).href;
const fakes = new Map([
  ["../../shims/shellBase", "export const refreshDocument = async () => {};"],
  ["../../../../browser/src/platform/app", "export const systemInfo = () => ({ appVersion: '0.2.45' });"],
  ["../../../../browser/src/platform/clipboard", "export const copyText = (text) => globalThis.__linuxUpdateTest.copied.push(text);"],
  ["../../../../browser/src/platform/dialogs", "export const confirm = async (options) => (globalThis.__linuxUpdateTest.dialogs.push(options), { confirmed: false });"],
  ["../../../../browser/src/platform/documents", "export const readDocument = (name) => globalThis.__linuxUpdateTest.docs.get(name) ?? null; export const saveDocument = async (name, contents) => void globalThis.__linuxUpdateTest.docs.set(name, contents);"],
  ["../../../../browser/src/state/browser/actions", "export const openUrls = (urls) => globalThis.__linuxUpdateTest.opened.push(...urls);"],
  ["../../../../browser/src/state/settings/settingsWindows", "export const openUrlFromSettings = (url) => globalThis.__linuxUpdateTest.opened.push(url);"],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === entry && fakes.has(specifier)
      ? { url: `data:text/javascript,${encodeURIComponent(fakes.get(specifier))}`, shortCircuit: true }
      : next(specifier, context);
  },
});
const { linuxUpdaterFor } = await import("./linuxUpdates.ts");
hooks.deregister();
const { SplitToast } = await import("../../../../browser/src/components/split/SplitChrome.tsx");

function harness({ kind, phase = "idle", windowId = "main", docs = new Map(), version = "0.2.46" } = {}) {
  const state = { docs, opened: [], copied: [], dialogs: [], version };
  globalThis.__linuxUpdateTest = state;
  useToasts.setState({ toasts: {} });
  setConsentPeriod(true, "linux-update-toast-test");
  takeUpdateCounts();
  const host = {
    bootstrap: { windowId, capabilities: ["ArdiaUpdates.releases", ...(kind ? SELF_UPDATE_METHODS : [])] },
    invoke: async (method) => {
      if (method === "ArdiaUpdates.status") return { kind, phase, version, reason: "network", run: phase === "idle" ? 0 : 1 };
      if (method === "ArdiaUpdates.claimOutcome") return true;
      assert.equal(method, "ArdiaUpdates.releases");
      return { status: 200, body: JSON.stringify([{ tag_name: `v${state.version}`, html_url: `https://github.com/ardia-browser/ardia/releases/tag/v${state.version}`, assets: [{ name: `Ardia-${state.version}-linux-x64.tar.xz` }] }]) };
    },
  };
  return { ...state, state, updater: linuxUpdaterFor(host) };
}

function toast(t) {
  const mounted = mount(() => SplitToast.type({ windowId: "main" }));
  t.after(() => mounted.unmount());
  return mounted;
}

for (const kind of [undefined, "managed"]) {
  test(`${kind ?? "manual"} updates can be dismissed without opening a page or dialog, including after relaunch`, async (t) => {
    const { updater, state } = harness({ kind });
    await updater.check(false);
    const shown = toast(t);
    assert.equal(shown.value.props.secondary, "Later");
    shown.value.props.onSecondary();
    shown.rerender();
    assert.equal(shown.value, null);
    assert.equal(useToasts.getState().toasts.main, null);
    assert.deepEqual(state.opened, []);
    assert.deepEqual(state.dialogs, []);
    assert.deepEqual(state.copied, []);
    assert.equal(takeUpdateCounts().update_notices_dismissed, 1);
    await updater.check(false);
    assert.equal(useToasts.getState().toasts.main, null, "the same version stays dismissed");
    const next = harness({ kind, docs: state.docs });
    await next.updater.check(false);
    assert.equal(useToasts.getState().toasts.main, undefined, "relaunch does not offer the same version");
    next.state.version = "0.2.47";
    await next.updater.check(false);
    assert.equal(useToasts.getState().toasts.main.title, "Ardia 0.2.47 is available");
  });
}

test("View still opens the offered release page and closes the toast", async (t) => {
  const { updater, opened } = harness();
  await updater.check(false);
  const shown = toast(t);
  assert.equal(shown.value.props.action, "View");
  shown.value.props.onAction();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.deepEqual(opened, ["https://github.com/ardia-browser/ardia/releases/tag/v0.2.46"]);
  const counts = takeUpdateCounts();
  assert.equal(counts.update_release_page_opens, 1);
  assert.equal(counts.update_notices_dismissed ?? 0, 0);
});

test("a failed automatic update's release-page notice can be dismissed", async (t) => {
  const { updater, opened, docs } = harness({ kind: "deb", phase: "failed" });
  await updater.watch();
  await updater.watch();
  const shown = toast(t);
  assert.equal(shown.value.props.secondary, "Later");
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.deepEqual(opened, []);
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).failed, "0.2.46");
  assert.equal(takeUpdateCounts().update_notices_dismissed, 1);
});

test("dismissals count only while telemetry sharing is on", async (t) => {
  const { updater } = harness();
  await updater.check(false);
  const shown = toast(t);
  setConsentPeriod(false, null);
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.equal(takeUpdateCounts().update_notices_dismissed ?? 0, 0);
});

test("utility windows do not create update notices", async () => {
  const { updater } = harness({ windowId: "settings" });
  await updater.check(false);
  assert.deepEqual(useToasts.getState().toasts, {});
});
