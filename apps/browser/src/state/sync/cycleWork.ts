import { consentToken, onConsentPeriodChange, stillValid } from "../telemetry/choice";
import { beginActivity } from "../app/jobActivity";
import { takeFolderCounts } from "./folderMove";
import { takeReturnedDeviceRemovals, takeReturnedProfileRemovals, takeSyncedDeviceRemovals, takeSyncedProfileRemovals } from "./profileRemoval";

const NO_CYCLES = { cycles: 0, ms: 0, longestMs: 0 };
let work = NO_CYCLES;

onConsentPeriodChange(() => ((work = NO_CYCLES), (reapplied = 0)));

export function timedCycle(startedAt: number, cycle: Promise<void>): Promise<void> {
  const done = beginActivity("sync", startedAt);
  void cycle.then(done, done);
  const token = consentToken();
  if (token === null) return cycle;
  return cycle.finally(() => {
    if (!stillValid(token)) return;
    const ms = Date.now() - startedAt;
    work = { cycles: work.cycles + 1, ms: work.ms + ms, longestMs: Math.max(work.longestMs, ms) };
  });
}

export function takeCycleWork() {
  const taken = work;
  work = NO_CYCLES;
  return taken;
}

let snapshotWrites = { count: 0, bytes: 0 };
let reapplied = 0;

export function noteSnapshot({ snapshotBytes, reapplied: found }: { snapshotBytes: number; reapplied: number }) {
  if (snapshotBytes) snapshotWrites = { count: snapshotWrites.count + 1, bytes: snapshotWrites.bytes + snapshotBytes };
  reapplied += found;
}

export function takeSnapshotWrites() {
  const taken = { ...snapshotWrites, reapplied, ...takeCycleWork(), removedProfiles: takeSyncedProfileRemovals(), removedDevices: takeSyncedDeviceRemovals(), removalsReturned: takeReturnedProfileRemovals() + takeReturnedDeviceRemovals(), folders: takeFolderCounts() };
  snapshotWrites = { count: 0, bytes: 0 };
  reapplied = 0;
  return taken;
}
