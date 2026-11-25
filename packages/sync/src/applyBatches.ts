import { canonical } from "./canon.ts";
import { visible } from "./scopeKeys.ts";
import type { ApplyBatch, ScopeOptions, ScopeState } from "./scopeState.ts";

export const ABSENT = "null";
const NATIVE_SAVE_MS = 30_000;
export const UNSEEN_KEPT_MS = 86_400_000;

const thisLaunch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const steadyNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export const launchOf = (options: ScopeOptions = {}) => options.launch ?? thisLaunch;
const monotonicOf = (options: ScopeOptions = {}) => (options.monotonic ?? steadyNow)();

export function fingerprint(json: string): string {
  let h1 = 0xdeadbeef ^ json.length;
  let h2 = 0x41c6ce57 ^ json.length;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

const isStep = (v: unknown) => Array.isArray(v) && v.length === 2 && (v[0] === null || typeof v[0] === "string") && typeof v[1] === "string";
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isApplyBatch(v: unknown): v is ApplyBatch {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  if (!isFiniteNumber(b.id) || typeof b.p !== "string" || typeof b.l !== "string" || !isFiniteNumber(b.at)) return false;
  if (b.done !== undefined && !isFiniteNumber(b.done)) return false;
  if (b.r !== undefined && b.r !== 1) return false;
  return typeof b.k === "object" && b.k !== null && !Array.isArray(b.k) && Object.values(b.k).every(isStep);
}

export const validBatches = (v: unknown): ApplyBatch[] => (Array.isArray(v) ? v.filter(isApplyBatch) : []);

function noteBatch(state: ScopeState, prefix: string, keys: Iterable<string>, now: number, options: ScopeOptions): ApplyBatch | null {
  const view = visible(state, prefix);
  const k: ApplyBatch["k"] = {};
  let noted = false;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const from = state.base[key];
    const to = view.has(key) ? canonical(view.get(key)) : ABSENT;
    if ((from ?? ABSENT) === to) continue;
    k[key] = [from ?? null, fingerprint(to)];
    noted = true;
  }
  if (!noted) return null;
  const batches = (state.applying ??= []);
  const id = Math.max(now, ...batches.map((b) => b.id + 1));
  const batch: ApplyBatch = { id, p: prefix, l: launchOf(options), at: now, k };
  batches.push(batch);
  return batch;
}

function dropBatch(state: ScopeState, batch: ApplyBatch) {
  state.applying = state.applying?.filter((b) => b !== batch);
  if (!state.applying?.length) delete state.applying;
}

export type WriteAhead = { batch: ApplyBatch | null; failed: boolean };

export async function writeAhead(state: ScopeState, prefix: string, keys: Iterable<string>, now: number, options: ScopeOptions = {}): Promise<WriteAhead> {
  const persist = options.persistApplying;
  const batch = persist ? noteBatch(state, prefix, keys, now, options) : null;
  if (!persist || !batch) return { batch: null, failed: false };
  try {
    await persist(batch);
    return { batch, failed: false };
  } catch (error) {
    console.warn(`[sync] couldn't journal what ${prefix} is about to apply`, error);
    dropBatch(state, batch);
    return { batch: null, failed: true };
  }
}

export function finishBatch(batch: ApplyBatch | null, options: ScopeOptions = {}) {
  if (batch) batch.done = monotonicOf(options);
}

export function startApplying(state: ScopeState, now: number, options: ScopeOptions = {}) {
  takeReapplied(state);
  if (!state.applying) return;
  const launch = launchOf(options);
  const steady = monotonicOf(options);
  const saveMs = options.nativeSaveMs ?? NATIVE_SAVE_MS;
  const live = (b: ApplyBatch) => {
    if (b.l === launch) return b.done === undefined || steady - b.done < saveMs;
    return !b.r || now - b.at < UNSEEN_KEPT_MS;
  };
  state.applying = state.applying.filter(live);
  if (!state.applying.length) delete state.applying;
}

const recovering = new WeakMap<ScopeState, Set<string>>();
const reapplied = new WeakMap<ScopeState, number>();

export function queueRecovered(state: ScopeState, keys: string[]) {
  if (!keys.length) return;
  const queued = new Set(state.unapplied);
  let marks = recovering.get(state);
  if (!marks) recovering.set(state, (marks = new Set()));
  for (const key of keys) {
    marks.add(key);
    if (queued.has(key)) continue;
    queued.add(key);
    state.unapplied.push(key);
  }
}

export function countReapplied(state: ScopeState, applied: Iterable<string>, deferred: Set<string>) {
  const marks = recovering.get(state);
  if (!marks?.size) return;
  let count = 0;
  for (const key of applied) {
    if (deferred.has(key) || !marks.delete(key)) continue;
    count++;
  }
  if (count) reapplied.set(state, (reapplied.get(state) ?? 0) + count);
}

export function takeReapplied(state: ScopeState): number {
  const count = reapplied.get(state) ?? 0;
  reapplied.delete(state);
  return count;
}
