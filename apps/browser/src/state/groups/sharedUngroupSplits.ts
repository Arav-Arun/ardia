import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { inPinnedContainer, newId, pinKeyOf } from "../browser/model";
import { hasPage } from "../tabs/pageSession";
import { splitTabIds } from "../splits/splits";

export function keepUngroupedSplitsHome(s: BrowserState, homeId: string, members: Set<string>): BrowserState {
  if (!Object.keys(s.splits ?? {}).length) return s;
  const leaving = (v: BrowserState["splits"][string]) => splitTabIds(v).every((id) => members.has(id) && s.tabs[id] && !inPinnedContainer(s, id));
  const homeSplits = Object.values(s.splits).filter((v) => v.windowId === homeId && leaving(v));
  const home = new Set(homeSplits.flatMap((v) => splitTabIds(v)).map((id) => pinKeyOf(s.tabs[id]!)));
  const away = Object.values(s.splits).filter((v) => v.windowId !== homeId && leaving(v) && splitTabIds(v).every((id) => home.has(pinKeyOf(s.tabs[id]!))));
  const panes = new Set([...homeSplits, ...away].flatMap((v) => splitTabIds(v)));
  const shown = new Map<string, string>();
  for (const t of Object.values(s.tabs)) {
    if (panes.has(t.id) || !hasPage(t) || !home.has(pinKeyOf(t)) || inPinnedContainer(s, t.id)) continue;
    shown.set(pinKeyOf(t), t.url);
  }
  const live = [...panes].map((id) => s.tabs[id]!).filter(hasPage);
  live.sort((a, b) => Number(b.windowId === homeId) - Number(a.windowId === homeId) || b.lastActiveAt - a.lastActiveAt);
  let tabs: Record<string, Tab> | null = null;
  for (const t of live) {
    const url = shown.get(pinKeyOf(t));
    if (url === undefined) shown.set(pinKeyOf(t), t.url);
    else if (url !== t.url) (tabs ??= { ...s.tabs })[t.id] = { ...t, pinKey: newId("tab") };
  }
  if (!away.length && !tabs) return s;
  const splits = { ...s.splits };
  for (const v of away) delete splits[v.id];
  return { ...s, splits, ...(tabs ? { tabs } : {}) };
}
