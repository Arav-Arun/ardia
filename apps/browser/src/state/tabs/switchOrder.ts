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

export function inOrderTabIds(s: BrowserState, windowId: string): string[] {
  const active = activeTabId(s, windowId);
  const eligible = (id: string) => id === active || isSwitchableTab(s, id);
  return numberedTabs(s, windowId, eligible).filter(eligible);
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
