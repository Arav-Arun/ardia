import { goToSettingsPane, type SettingsPlace } from "../../browser/src/state/settings/settingsWindows";
import { findSetting, PANES } from "../../browser/src/components/settings/settingsIndex";
import { dropSettingsSearch, revealSettingRow } from "../../browser/src/state/settings/searchState";
import { consentToken } from "../../browser/src/state/telemetry/choice";
import { setPreferredImportSource } from "./settingsWindows";

export function navigateUtility(value: unknown) {
  if (!value || typeof value !== "object") return;
  const place = value as SettingsPlace;
  const importSource = (value as { importSource?: unknown }).importSource;
  if (typeof importSource === "string") setPreferredImportSource(importSource);
  if (!PANES.some((pane) => pane.id === place.pane)) return;
  goToSettingsPane(place.pane, typeof place.profileId === "string" ? place.profileId : null, typeof place.detail === "string" ? place.detail : null);
  const reveal = (value as { reveal?: unknown }).reveal;
  if (typeof reveal !== "string" || findSetting(reveal)?.pane !== place.pane) return;
  dropSettingsSearch(consentToken());
  revealSettingRow(reveal);
}
