import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { installOfficialPlugin } = await import("./official.ts");
const { setProgramControlInferredOff, userTurnedControlOff } = await import("../app/programControlSetting.ts");
const { officialPinnedFromPin } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

const CLI = JSON.stringify({ manifest: 2, name: "cli", title: "Command Line", version: "0.3.0", alwaysOn: true, official: true, permissions: { control: true }, contributes: { programs: [{ name: "ardia", path: "bin/ardia", claim: true }] } });
const BUILT_IN = { status: "ok", folderId: officialPinnedFromPin().find((p) => p.name === "cli").folderId, official: true };

setConsentPeriod(true, "test-epoch");
S().hydrate({});
host.links.length = 0;
host.linkResult = { ok: true, linked: ["ardia"], refused: {}, binDir: "/home/.local/bin" };
host.folders = [{ name: "cli", text: CLI, ...BUILT_IN }];
startPlugins();
await settle();

test("approving Command Line turns control on after the engine stopped control itself", async () => {
  S().updateSettings({ cliControl: true });
  setProgramControlInferredOff();
  assert.equal(S().settings.cliControl, false);
  assert.equal(userTurnedControlOff(), false);
  const done = installOfficialPlugin("cli", { showSheet: false });
  assert.ok(lifecycle.enablePlugin("cli", P().consent.hash));
  assert.deepEqual(await done, { ok: true });
  assert.equal(S().settings.cliControl, true);
  host.linkResult = null;
});
