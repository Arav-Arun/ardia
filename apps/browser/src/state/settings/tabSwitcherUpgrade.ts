import { isFields, isStringList } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { staticShortcutSources } from "../commands/commandCatalog";
import { ctrlTabUpgrade } from "../commands/ctrlTabKeys";
import type { ShortcutOverrides } from "../commands/shortcuts";
import type { Settings, SettingsMeta } from "./settings";

export const TAB_SWITCHER_MODES_APPLIED = "tabSwitcherOrder:fromShortcuts";

const isOverrides = (v: unknown): v is ShortcutOverrides => isFields(v) && Object.values(v).every(isStringList);

const STEPPED = { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" } as const;

type Upgraded<S> = { settings: S | undefined; settingsMeta: SettingsMeta };

function upgradedFields(fields: Record<string, unknown>, usedToStep: boolean): { fields: Record<string, unknown>; stepped: boolean } {
  if (!isOverrides(fields.shortcuts) || "tabSwitcherOrder" in fields || "tabSwitcherView" in fields) return { fields, stepped: false };
  const { shortcuts, stepped } = ctrlTabUpgrade(fields.shortcuts, staticShortcutSources(), { usedToStep });
  if (!stepped && shortcuts === fields.shortcuts) return { fields, stepped: false };
  return { fields: { ...fields, shortcuts, ...(stepped ? STEPPED : {}) }, stepped };
}

export function withTabSwitcherModes<S extends object>(saved: S | undefined, meta: SettingsMeta, usedToStep = PLATFORM_FEATURES.ctrlTabUsedToStep): Upgraded<S> {
  if (meta.inferred.includes(TAB_SWITCHER_MODES_APPLIED)) return { settings: saved, settingsMeta: meta };
  const settingsMeta = { chosen: meta.chosen, inferred: [...meta.inferred, TAB_SWITCHER_MODES_APPLIED] };
  if (!saved) return { settings: saved, settingsMeta };
  const { fields, stepped } = upgradedFields(saved as Record<string, unknown>, usedToStep);
  return { settings: fields as S, settingsMeta: stepped ? { ...settingsMeta, chosen: [...new Set([...meta.chosen, ...Object.keys(STEPPED)])] } : settingsMeta };
}

export function withSyncedTabSwitcherModes(patch: Partial<Settings>): Partial<Settings> {
  return upgradedFields(patch, false).fields as Partial<Settings>;
}
