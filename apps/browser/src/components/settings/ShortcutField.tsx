import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { cancelShortcutRecording, recordShortcut, resolvedShortcuts, useMenuBarRevision, type MenuShortcut } from "../../state/commands/commandShortcuts";
import { formatShortcut, isMouseShortcut, sameShortcut, type ResolvedShortcuts, type Shortcut } from "../../state/commands/shortcuts";
import { useSettings } from "../../state/browser/hooks";
import { useProfileOrder } from "../../state/profiles/hooks";
import { setMouseShortcut, setShortcutOverride } from "../../state/settings/actions";
import { shortcutItems } from "../../state/settings/paneData";
import { useResource } from "../../state/settings/resources";
import { KeyCap, space, Symbol, Text, useHover } from "../ui";
import { useTheme } from "../ui/theme";

export const NO_SHORTCUT: Shortcut = { key: "", modifiers: [] };

export type RecordedChange = "changed" | "cleared" | "mouse" | null;

export function applyRecordedShortcut(item: MenuShortcut, combo: Shortcut | null, resolved: ResolvedShortcuts): RecordedChange {
  if (!combo) return null;
  if (isMouseShortcut(combo)) {
    if (!item.remappable || !item.mouseBindable) return null;
    setMouseShortcut(item.id, combo);
    return "mouse";
  }
  const isDefault = sameShortcut(combo, resolved.defaultsOf(item.id)[0] ?? NO_SHORTCUT);
  setShortcutOverride(item.id, isDefault ? null : combo);
  return "changed";
}

export function clearShortcut(item: MenuShortcut, resolved: ResolvedShortcuts) {
  setShortcutOverride(item.id, resolved.defaultsOf(item.id).length ? NO_SHORTCUT : null);
}

export function useResolvedShortcuts(items: readonly MenuShortcut[] | null | undefined): ResolvedShortcuts {
  const overrides = useSettings((s) => s.shortcuts);
  const mouseOverrides = useSettings((s) => s.mouseShortcuts);
  const profileOrder = useProfileOrder();
  const menuBar = useMenuBarRevision();
  return useMemo(() => resolvedShortcuts({ settings: { shortcuts: overrides, mouseShortcuts: mouseOverrides }, profileOrder }), [items, overrides, mouseOverrides, profileOrder, menuBar]);
}

export function CommandKeyField({ command, onChange }: { command: string; onChange?: (change: Exclude<RecordedChange, null>) => void }) {
  const [items] = useResource(shortcutItems);
  const resolved = useResolvedShortcuts(items);
  const [recording, setRecording] = useState(false);
  const recordingNow = useRef(false);
  useEffect(() => () => void (recordingNow.current && cancelShortcutRecording()), []);
  const item = items?.find((i) => i.id === command);
  if (!item) return null;
  const record = async () => {
    recordingNow.current = true;
    setRecording(true);
    const combo = await recordShortcut();
    recordingNow.current = false;
    setRecording(false);
    const change = applyRecordedShortcut(item, combo, resolved);
    if (change) onChange?.(change);
  };
  return (
    <KeyField
      combo={resolved.bindings.get(command)?.[0] ?? NO_SHORTCUT}
      remappable={item.remappable}
      recording={recording}
      tooltip="Change Shortcut"
      onRecord={() => void record()}
      onClear={() => {
        clearShortcut(item, resolved);
        onChange?.("cleared");
      }}
    />
  );
}

type ShortcutFieldProps = { combo: Shortcut; mouse?: Shortcut; remappable: boolean; recording: boolean; tooltip?: string; onRecord: () => void; onClear: () => void; onClearMouse: () => void };

export function ShortcutField({ mouse, onClearMouse, ...keys }: ShortcutFieldProps) {
  if (!mouse) return <KeyField {...keys} />;
  return (
    <View style={FIELDS}>
      <KeyField {...keys} />
      <MouseField button={mouse} onClear={onClearMouse} />
    </View>
  );
}

function MouseField({ button, onClear }: { button: Shortcut; onClear: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} style={KEY_FIELD}>
      <KeyCap keys={[formatShortcut(button)]} hovered={hovered} />
      {hovered ? (
        <Pressable onPress={onClear} tooltip="Remove Mouse Shortcut" style={CLEAR}>
          <Symbol name="xmark.circle.fill" size={11} color={theme.textTertiary} style={CLEAR_GLYPH} />
        </Pressable>
      ) : null}
    </View>
  );
}

function KeyField({ combo, remappable, recording, tooltip, onRecord, onClear }: Omit<ShortcutFieldProps, "mouse" | "onClearMouse">) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const text = recording ? "Type Shortcut" : formatShortcut(combo);
  if (!remappable) {
    return (
      <View style={FIXED_KEYS} tooltip="(not remappable)">
        <Text tone="textTertiary">{text || "—"}</Text>
      </View>
    );
  }
  return (
    <View {...hoverProps} style={KEY_FIELD}>
      <Pressable onPress={onRecord} tooltip={recording ? undefined : tooltip}>
        <KeyCap keys={[text || "None"]} editing={recording} empty={!text} hovered={hovered} />
      </Pressable>
      {hovered && !recording && combo.key ? (
        <Pressable onPress={onClear} tooltip="Remove Shortcut" style={CLEAR}>
          <Symbol name="xmark.circle.fill" size={11} color={theme.textTertiary} style={CLEAR_GLYPH} />
        </Pressable>
      ) : null}
    </View>
  );
}

const FIXED_KEYS = { minWidth: 110, alignItems: "flex-end" } as const;
const FIELDS = { flexDirection: "row", alignItems: "center", gap: space.s } as const;
const KEY_FIELD = { minWidth: 110, justifyContent: "center" } as const;
const CLEAR = { position: "absolute", right: space.xs } as const;
const CLEAR_GLYPH = { width: 14, height: 14 } as const;
