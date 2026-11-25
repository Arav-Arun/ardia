import type { BrowserState } from "../browser/store";
import { activeTabId } from "../browser/model";
import { numberedTabs } from "../sidebar/entries";
import { isPageUnloaded } from "../pins/pinShare";
import { isAsleep } from "./pageSession";
import { isSleeping } from "./sleepingTabs";

export function isSwitchableTab(s: BrowserState, id: string): boolean {
  const tab = s.tabs[id];
  return !!tab && !isAsleep(tab) && !isSleeping(id) && !isPageUnloaded(s, id);
}

function collapsedOwners(s: BrowserState, windowId: string): Map<string, string> {
  const owners = new Map<string, string>();
  const collapsedAbove = (parentId: string | null | undefined): boolean => {
    for (let parent = parentId ? s.groups[parentId] : undefined; parent; parent = parent.parentId ? s.groups[parent.parentId] : undefined) if (parent.collapsed) return true;
    return false;
  };
  for (const group of Object.values(s.groups)) {
    if (group.windowId !== windowId || !group.collapsed || collapsedAbove(group.parentId)) continue;
    for (const id of group.tabIds) owners.set(id, group.id);
  }
  return owners;
}

export function inOrderTabIds(s: BrowserState, windowId: string): string[] {
  const active = activeTabId(s, windowId);
  const eligible = (id: string) => id === active || isSwitchableTab(s, id);
  const owners = collapsedOwners(s, windowId);
  const stops: string[] = [];
  for (const id of numberedTabs(s, windowId, eligible)) {
    if (!eligible(id) || stops.includes(id)) continue;
    const owner = owners.get(id);
    const at = owner ? stops.findIndex((stop) => owners.get(stop) === owner) : -1;
    if (at < 0) stops.push(id);
    else if (id === active) stops[at] = id;
  }
  return stops;
}

export function stepFrom(ids: readonly string[], from: string | undefined, delta: 1 | -1): number {
  const at = from ? ids.indexOf(from) : -1;
  if (at < 0) return delta > 0 ? 0 : ids.length - 1;
  return (at + delta + ids.length) % ids.length;
}

export function steppedTabId(s: BrowserState, windowId: string, delta: 1 | -1): string | undefined {
  const ids = inOrderTabIds(s, windowId);
  const active = activeTabId(s, windowId);
  const next = ids[stepFrom(ids, active, delta)];
  return next && next !== active ? next : undefined;
}
