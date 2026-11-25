import { isMouseShortcut, sameShortcut, type ResolvedShortcuts, type Shortcut } from "../commands/shortcuts";
import { setMouseShortcut, setShortcutOverride } from "./actions";

export const NO_SHORTCUT: Shortcut = { key: "", modifiers: [] };

export type RecordedChange = "changed" | "cleared" | "mouse";

type Bindable = { id: string; remappable: boolean; mouseBindable?: boolean };

export function applyRecordedShortcut(item: Bindable, combo: Shortcut | null | undefined, resolved: ResolvedShortcuts): RecordedChange | null {
  if (!combo) return null;
  if (isMouseShortcut(combo)) {
    if (!item.remappable || !item.mouseBindable) return null;
    const current = resolved.mouse.get(item.id);
    if (current && sameShortcut(current, combo)) return null;
    setMouseShortcut(item.id, combo);
    return "mouse";
  }
  if (sameShortcut(combo, resolved.bindings.get(item.id)?.[0] ?? NO_SHORTCUT)) return null;
  const isDefault = sameShortcut(combo, resolved.defaultsOf(item.id)[0] ?? NO_SHORTCUT);
  setShortcutOverride(item.id, isDefault ? null : combo);
  return "changed";
}

export function clearShortcut(item: { id: string }, resolved: ResolvedShortcuts): RecordedChange | null {
  if (!resolved.bindings.get(item.id)?.length) return null;
  setShortcutOverride(item.id, resolved.defaultsOf(item.id).length ? NO_SHORTCUT : null);
  return "cleared";
}
