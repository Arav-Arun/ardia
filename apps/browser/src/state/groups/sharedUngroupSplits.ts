import type { BrowserState } from "../browser/store";
import type { BrowserWindow, Tab } from "../browser/types";
import { inPinnedContainer, pinKeyOf } from "../browser/model";
import { frozenOn, hasPage, withNavigationAt } from "../tabs/pageSession";
import { splitTabIds, withPaneIds } from "../splits/splits";
import { removeTabs } from "../tabs/tabs";

const swapIn = (ids: string[], a: string, b: string) => (ids.includes(a) || ids.includes(b) ? ids.map((x) => (x === a ? b : x === b ? a : x)) : ids);

function swapWindow(w: BrowserWindow, a: string, b: string): BrowserWindow {
  const active = Object.entries(w.activeTabIds);
  const touched = active.some(([, id]) => id === a || id === b);
  return { ...w, tabIds: swapIn(w.tabIds, a, b), ...(touched ? { activeTabIds: Object.fromEntries(active.map(([p, id]) => [p, id === a ? b : id === b ? a : id])) } : {}) };
}

function handPageOver(s: BrowserState, holder: Tab, copy: Tab): BrowserState {
  const windows = { ...s.windows, [holder.windowId]: swapWindow(s.windows[holder.windowId]!, holder.id, copy.id), [copy.windowId]: swapWindow(s.windows[copy.windowId]!, holder.id, copy.id) };
  const tabs = {
    ...s.tabs,
    [holder.id]: { ...holder, windowId: copy.windowId, page: withNavigationAt(holder) },
    [copy.id]: { ...copy, windowId: holder.windowId, page: frozenOn(copy, holder.id) },
  };
  let splits = s.splits;
  for (const [id, v] of Object.entries(s.splits)) {
    const ids = swapIn(splitTabIds(v), holder.id, copy.id);
    if (ids !== splitTabIds(v)) (splits === s.splits ? (splits = { ...s.splits }) : splits)[id] = withPaneIds(v, ids);
  }
  let groups = s.groups;
  for (const g of Object.values(s.groups)) {
    const ids = swapIn(g.tabIds, holder.id, copy.id);
    if (ids !== g.tabIds) (groups === s.groups ? (groups = { ...s.groups }) : groups)[g.id] = { ...g, tabIds: ids };
  }
  let selection = s.selection;
  for (const [w, ids] of Object.entries(s.selection)) {
    const next = swapIn(ids, holder.id, copy.id);
    if (next !== ids) selection = { ...selection, [w]: next };
  }
  return { ...s, tabs, windows, splits, groups, selection };
}

export function keepUngroupedSplitsHome(s: BrowserState, homeId: string, members: Set<string>): BrowserState {
  if (!Object.keys(s.splits ?? {}).length) return s;
  const leaving = (v: BrowserState["splits"][string]) => splitTabIds(v).every((id) => members.has(id) && s.tabs[id] && !inPinnedContainer(s, id));
  const home = new Map<string, string>();
  for (const v of Object.values(s.splits)) if (v.windowId === homeId && leaving(v)) for (const id of splitTabIds(v)) home.set(pinKeyOf(s.tabs[id]!), id);
  const away = Object.values(s.splits).filter((v) => v.windowId !== homeId && leaving(v) && splitTabIds(v).every((id) => home.has(pinKeyOf(s.tabs[id]!))));
  if (!away.length) return s;
  let next = s;
  const gone: string[] = [];
  for (const v of away) {
    for (const id of splitTabIds(v)) {
      const pane = next.tabs[id]!;
      const mine = next.tabs[home.get(pinKeyOf(pane))!]!;
      if (hasPage(pane) && !hasPage(mine)) {
        next = handPageOver(next, pane, mine);
        home.set(pinKeyOf(pane), pane.id);
        gone.push(mine.id);
      } else gone.push(pane.id);
    }
  }
  return removeTabs(next, gone, false);
}
