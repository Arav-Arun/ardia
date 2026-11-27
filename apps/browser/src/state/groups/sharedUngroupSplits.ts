import type { BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { inPinnedContainer, newId, pinKeyOf } from "../browser/model";
import { hasPage, holderOfPage, wakeOf } from "../tabs/pageSession";
import { splitTabIds } from "../splits/splits";

export const keepUngroupedTabs = (s: BrowserState, homeId: string, members: Set<string>): BrowserState => keepSameTabRows(keepSplitsHome(s, homeId, members), members);

const ownsPage = (t: Tab) => hasPage(t) || !!wakeOf(t);

function keepSameTabRows(s: BrowserState, members: Set<string>): BrowserState {
  const holders = new Set(Object.values(s.tabs).map(holderOfPage).filter(Boolean));
  let tabs: Record<string, Tab> | null = null;
  const rekey = (t: Tab) => ((tabs ??= { ...s.tabs })[t.id] = { ...t, pinKey: newId("tab") });
  for (const id of members) {
    const m = s.tabs[id];
    if (!m || !ownsPage(m) || inPinnedContainer(s, id)) continue;
    for (const rowId of s.windows[m.windowId]?.tabIds ?? []) {
      const t = (tabs ?? s.tabs)[rowId];
      if (!t || members.has(rowId) || t.pin || t.profileId !== m.profileId || pinKeyOf(t) !== pinKeyOf(m) || !ownsPage(t) || inPinnedContainer(s, rowId)) continue;
      if (holders.has(t.id) && !holders.has(m.id)) {
        rekey(m);
        break;
      }
      rekey(t);
    }
  }
  return tabs ? { ...s, tabs } : s;
}

function keepSplitsHome(s: BrowserState, homeId: string, members: Set<string>): BrowserState {
  if (!Object.keys(s.splits ?? {}).length) return s;
  const leaving = (v: BrowserState["splits"][string]) => splitTabIds(v).every((id) => members.has(id) && s.tabs[id] && !inPinnedContainer(s, id));
  const homeSplits = Object.values(s.splits).filter((v) => v.windowId === homeId && leaving(v));
  const home = new Set(homeSplits.flatMap((v) => splitTabIds(v)).map((id) => pinKeyOf(s.tabs[id]!)));
  const away = Object.values(s.splits).filter((v) => v.windowId !== homeId && leaving(v) && splitTabIds(v).every((id) => home.has(pinKeyOf(s.tabs[id]!))));
  const panes = new Set([...homeSplits, ...away].flatMap((v) => splitTabIds(v)));
  const shown = new Set<string>();
  for (const t of Object.values(s.tabs)) {
    if (!panes.has(t.id) && hasPage(t) && home.has(pinKeyOf(t)) && !inPinnedContainer(s, t.id)) shown.add(pinKeyOf(t));
  }
  const live = [...panes].map((id) => s.tabs[id]!).filter(hasPage);
  live.sort((a, b) => Number(b.windowId === homeId) - Number(a.windowId === homeId) || b.lastActiveAt - a.lastActiveAt);
  let tabs: Record<string, Tab> | null = null;
  for (const t of live) {
    if (!shown.has(pinKeyOf(t))) shown.add(pinKeyOf(t));
    else (tabs ??= { ...s.tabs })[t.id] = { ...t, pinKey: newId("tab") };
  }
  if (!away.length && !tabs) return s;
  const splits = { ...s.splits };
  for (const v of away) delete splits[v.id];
  return { ...s, splits, ...(tabs ? { tabs } : {}) };
}
