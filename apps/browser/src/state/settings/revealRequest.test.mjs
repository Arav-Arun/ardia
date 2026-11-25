import assert from "node:assert/strict";
import { mock, test } from "node:test";
const { openSettings, replaceSettingsPlace, goToSettingsPane, useSettingsNav } = await import("./settingsWindows.ts");
const { REVEAL_MEASURE_MS, revealSettingRow, revealTargetShown, revealWanted, runReveal, setSettingsQuery, useSettingsSearch } = await import("./searchState.ts");
const usage = await import("../telemetry/usage.ts");
const client = await import("../telemetry/client.ts");
const { consentToken } = await import("../telemetry/choice.ts");
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const nav = () => useSettingsNav.getState();
const request = () => useSettingsSearch.getState().reveal;
const at = (pane, profileId = null, detail = null) => useSettingsNav.setState({ pane, profileId, detail, back: [], forward: [] });

let missesSeen = 0;
async function revealMisses() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  const total = events.reduce((sum, e) => sum + (e.settings_reveal_misses ?? 0), 0);
  const added = total - missesSeen;
  missesSeen = total;
  return added;
}

function anchor() {
  const calls = [];
  return { calls, still: () => true, measure: (found, failed) => calls.push({ found, failed }) };
}

test("S1: Manage Extensions commits the destination before it asks for the row, so the request names that destination", () => {
  at("general");
  let seen = null;
  const unsubscribe = useSettingsSearch.subscribe((s) => {
    if (s.reveal && !seen) seen = { pane: nav().pane, profileId: nav().profileId };
  });
  setSettingsQuery("cookies");
  openSettings("profiles", "work", null, "profiles.extensions");
  unsubscribe();
  assert.deepEqual(seen, { pane: "profiles", profileId: "work" }, "navigation was already at the destination when the reveal was published");
  assert.deepEqual(request().target, { pane: "profiles", profileId: "work", detail: null });
  assert.equal(revealWanted(request(), nav()), true);
  assert.equal(useSettingsSearch.getState().query, "");
});

test("S2: a request for profile B is dropped when the user moves on to C before B shows, and never follows C", () => {
  at("profiles", "a");
  openSettings("profiles", "b", null, "profiles.extensions");
  const forB = request();
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "a", detail: null }, forB), false, "A is still shown while B loads");
  replaceSettingsPlace("c");
  assert.equal(revealWanted(forB, nav()), false, "C supersedes B's request");
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "c", detail: null }, forB), false);
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "b", detail: "extension:x" }, forB), false, "B's extension page is not B's overview");
  assert.equal(revealTargetShown({ pane: "profiles", profileId: "b", detail: null }, forB), true);
});

test("S3: a measurement answered after a newer request neither scrolls, flashes nor clears the newer one", () => {
  at("profiles", "work");
  revealSettingRow("profiles.extensions");
  const first = request();
  const old = anchor();
  const placed = [];
  runReveal(first, "profiles.extensions", null, old, (y) => placed.push(["first", y]));
  revealSettingRow("profiles.extensions");
  const second = request();
  assert.notEqual(second.token, first.token);
  old.calls[0].found(400, 30);
  old.calls[0].failed();
  assert.deepEqual(placed, []);
  assert.equal(request().token, second.token, "the newer request is still pending");
  const fresh = anchor();
  runReveal(second, "profiles.extensions", null, fresh, (y) => placed.push(["second", y]));
  fresh.calls[0].found(500, 30);
  assert.deepEqual(placed, [["second", 500]]);
  assert.equal(request(), null);
  assert.equal(useSettingsSearch.getState().flash.id, "profiles.extensions");
});

test("S3: a measurement whose anchor was replaced since it was asked for does nothing", () => {
  at("profiles", "work");
  revealSettingRow("profiles.extensions");
  const asked = request();
  let current = true;
  const placed = [];
  const replaced = { still: () => current, measure: (found) => { current = false; found(300, 30); } };
  runReveal(asked, "profiles.extensions", null, replaced, (y) => placed.push(y));
  assert.deepEqual(placed, []);
  assert.equal(request().token, asked.token);
});

test("S4: a failed or unanswered measurement counts one miss and ends the request", async (t) => {
  client.setSharing(true, "onboarding");
  t.after(() => client.setSharing(false, "settings"));
  await revealMisses();
  const consent = consentToken();
  at("profiles", "work");
  revealSettingRow("profiles.extensions");
  const failing = anchor();
  runReveal(request(), "profiles.extensions", consent, failing, () => {});
  failing.calls[0].failed();
  failing.calls[0].failed();
  assert.equal(request(), null);
  assert.equal(await revealMisses(), 1);

  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  revealSettingRow("profiles.extensions");
  const silent = anchor();
  runReveal(request(), "profiles.extensions", consent, silent, () => {});
  mock.timers.tick(REVEAL_MEASURE_MS - 1);
  assert.notEqual(request(), null);
  mock.timers.tick(1);
  assert.equal(request(), null);
  silent.calls[0].failed();
  assert.equal(await revealMisses(), 1, "the unanswered measurement counts once, a late answer adds nothing");

  revealSettingRow("profiles.extensions");
  const stopped = runReveal(request(), "profiles.extensions", consent, anchor(), () => {});
  goToSettingsPane("general");
  stopped();
  mock.timers.tick(REVEAL_MEASURE_MS);
  assert.equal(await revealMisses(), 0, "a request the user navigated away from isn't a miss");
});
