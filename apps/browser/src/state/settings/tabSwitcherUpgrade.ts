import { isFields, isStringList } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { staticShortcutSources } from "../commands/commandCatalog";
import { ctrlTabUpgrade } from "../commands/ctrlTabKeys";
import type { ShortcutOverrides } from "../commands/shortcuts";
import type { SettingsMeta } from "./settings";

export const TAB_SWITCHER_MODES_APPLIED = "tabSwitcherOrder:fromShortcuts";

const isOverrides = (v: unknown): v is ShortcutOverrides => isFields(v) && Object.values(v).every(isStringList);

const STEPPED = { tabSwitcherOrder: "inOrder", tabSwitcherView: "none" } as const;

type Upgraded<S> = { settings: S | undefined; settingsMeta: SettingsMeta };

export function withTabSwitcherModes<S extends object>(saved: S | undefined, meta: SettingsMeta, usedToStep = PLATFORM_FEATURES.ctrlTabUsedToStep): Upgraded<S> {
  if (meta.inferred.includes(TAB_SWITCHER_MODES_APPLIED)) return { settings: saved, settingsMeta: meta };
  const settingsMeta = { chosen: meta.chosen, inferred: [...meta.inferred, TAB_SWITCHER_MODES_APPLIED] };
  const fields = saved as Record<string, unknown> | undefined;
  if (!fields || "tabSwitcherOrder" in fields || "tabSwitcherView" in fields) return { settings: saved, settingsMeta };
  const overrides = isOverrides(fields.shortcuts) ? fields.shortcuts : {};
  const choseShortcuts = meta.chosen.includes("shortcuts") && !meta.inferred.includes("shortcuts");
  const { shortcuts, stepped } = ctrlTabUpgrade(overrides, staticShortcutSources(), { usedToStep, choseShortcuts });
  const settings = { ...fields, ...(shortcuts !== overrides ? { shortcuts } : {}), ...(stepped ? STEPPED : {}) } as S;
  return { settings, settingsMeta: stepped ? { ...settingsMeta, chosen: [...new Set([...meta.chosen, ...Object.keys(STEPPED)])] } : settingsMeta };
}
