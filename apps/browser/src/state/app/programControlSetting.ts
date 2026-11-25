import { useBrowser, type BrowserState } from "../browser/store";
import type { ConsentToken } from "../telemetry/choice";
import { noteControlRestored } from "../telemetry/cliCounts";

const CONTROL_KEY = "cliControl";

export const programControlOn = (s: Pick<BrowserState, "settings">) => s.settings.cliControl;

export const setProgramControl = (on: boolean) => useBrowser.getState().updateSettings({ cliControl: on });

export const setControlFromSettings = (on: boolean) => setProgramControl(on);

export const setProgramControlInferredOff = () => useBrowser.getState().updateSettings({ cliControl: false }, { inferred: true });

function userChoseControl(): boolean {
  const { settingsMeta } = useBrowser.getState();
  return settingsMeta.chosen.includes(CONTROL_KEY) && !settingsMeta.inferred.includes(CONTROL_KEY);
}

export const userTurnedControlOff = () => !programControlOn(useBrowser.getState()) && userChoseControl();

export const controlStoppedItself = () => {
  const { settings, settingsMeta } = useBrowser.getState();
  return !settings.cliControl && settingsMeta.inferred.includes(CONTROL_KEY);
};

export function controlOnByApproval(consent: ConsentToken | null): boolean {
  if (programControlOn(useBrowser.getState()) || userTurnedControlOff()) return false;
  if (controlStoppedItself()) noteControlRestored(consent);
  return true;
}

export const useControlTurnedOff = () =>
  useBrowser((s) => !s.settings.cliControl && s.settingsMeta.chosen.includes(CONTROL_KEY) && !s.settingsMeta.inferred.includes(CONTROL_KEY));

export const compactControlPill = (s: Pick<BrowserState, "settings">) => s.settings.compactCliPill;
