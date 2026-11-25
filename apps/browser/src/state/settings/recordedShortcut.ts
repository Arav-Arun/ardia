import { isMouseShortcut, sameShortcut, storedShortcut, type ResolvedShortcuts, type Shortcut } from "../commands/shortcuts";
import { useBrowser } from "../browser/store";
import { setMouseShortcut, setShortcutOverride } from "./actions";

export const NO_SHORTCUT: Shortcut = { key: "", modifiers: [] };

export type RecordedChange = "changed" | "cleared" | "mouse";

type Bindable = { id: string; remappable: boolean; mouseBindable?: boolean };

export function applyRecordedShortcut(
  item: Bindable,
  combo: Shortcut | null | undefined,
  resolved: ResolvedShortcuts,
  saved: readonly string[] | undefined = useBrowser.getState().settings.shortcuts[item.id],
): RecordedChange | null {
  if (!combo) return null;
  if (isMouseShortcut(combo)) {
    if (!item.remappable || !item.mouseBindable) return null;
    const current = resolved.mouse.get(item.id);
    if (current && sameShortcut(current, combo)) return null;
    setMouseShortcut(item.id, combo);
    return "mouse";
  }
  const primary = resolved.defaultsOf(item.id)[0] ?? NO_SHORTCUT;
  const current = resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT;
  if (saved?.[0] ? sameShortcut(combo, storedShortcut(saved)) : !saved && sameShortcut(combo, primary) && sameShortcut(current, primary)) return null;
  const defaultIsFree = resolved.holdersOf(primary).every((holder) => holder === item.id);
  setShortcutOverride(item.id, sameShortcut(combo, primary) && defaultIsFree ? null : combo);
  return "changed";
}

export function clearShortcut(item: { id: string }, resolved: ResolvedShortcuts): RecordedChange | null {
  if (!resolved.bindings.get(item.id)?.length) return null;
  setShortcutOverride(item.id, resolved.defaultsOf(item.id).length ? NO_SHORTCUT : null);
  return "cleared";
}
