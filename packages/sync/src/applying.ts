import { canonical } from "./canon.ts";
import { dropBase, putBase } from "./scopeKeys.ts";
import type { Applying, ScopeOptions, ScopeState } from "./scopeState.ts";

const ABSENT = "null";
const NATIVE_SAVE_MS = 30_000;
const KEPT_PRIOR_VALUES = 8;

const thisLaunch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const launchOf = (options: ScopeOptions = {}) => options.launch ?? thisLaunch;

function fingerprint(json: string): string {
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

export function noteApplyingTo(state: ScopeState, keys: Iterable<string>, view: Map<string, unknown>, now: number, launch: string): boolean {
  let noted = false;
  for (const key of keys) {
    const from = state.base[key] ?? ABSENT;
    const to = view.has(key) ? canonical(view.get(key)) : ABSENT;
    if (from === to) continue;
    const entry = state.applying?.[key];
    const t = fingerprint(to);
    const w = [...new Set([...(entry?.w ?? []), fingerprint(from)])].filter((f) => f !== t).slice(-KEPT_PRIOR_VALUES);
    (state.applying ??= {})[key] = { w, t, at: now, l: launch };
    noted = true;
  }
  return noted;
}

export function startApplying(state: ScopeState, now: number, options: ScopeOptions = {}) {
  takeReapplied(state);
  const applying = state.applying;
  if (!applying) return;
  const launch = launchOf(options);
  const saveMs = options.nativeSaveMs ?? NATIVE_SAVE_MS;
  for (const key in applying) {
    const entry = applying[key]!;
    if (entry.l === launch && now - entry.at >= saveMs) delete applying[key];
  }
  if (!Object.keys(applying).length) delete state.applying;
}

const reapplied = new WeakMap<ScopeState, number>();

export function takeReapplied(state: ScopeState): number {
  const count = reapplied.get(state) ?? 0;
  reapplied.delete(state);
  return count;
}

export function reapplyStale(state: ScopeState, prefix: string, values: Map<string, unknown>, json: (key: string, value: unknown) => string, ignore: ((key: string) => boolean) | undefined, now: number, launch: string) {
  const native = (key: string) => (values.has(key) ? json(key, values.get(key)) : ABSENT);
  const { stale } = recoverApplied(state, prefix, native, (key) => !!ignore?.(key), now, launch);
  for (const key of stale) {
    if (state.unapplied.includes(key)) continue;
    state.unapplied.push(key);
    reapplied.set(state, (reapplied.get(state) ?? 0) + 1);
  }
}

type Recovered = { stale: string[]; adopted: number };

function recoverApplied(state: ScopeState, prefix: string, native: (key: string) => string, ignored: (key: string) => boolean, now: number, launch: string): Recovered {
  const recovered: Recovered = { stale: [], adopted: 0 };
  const applying = state.applying;
  if (!applying) return recovered;
  for (const key in applying) {
    if (!key.startsWith(prefix)) continue;
    const entry: Applying = applying[key]!;
    if (entry.l === launch) continue;
    const json = ignored(key) ? undefined : native(key);
    if (json === undefined) {
      applying[key] = { ...entry, at: now, l: launch };
      continue;
    }
    const base = state.base[key] ?? ABSENT;
    const f = fingerprint(json);
    if (f !== entry.t && entry.w.includes(f)) {
      if (json !== base) {
        if (json === ABSENT) dropBase(state, key);
        else putBase(state, key, json);
      }
      recovered.stale.push(key);
      continue;
    }
    if (f === entry.t && json !== base) {
      if (json === ABSENT) dropBase(state, key);
      else putBase(state, key, json);
      recovered.adopted++;
    }
    applying[key] = { ...entry, at: now, l: launch };
  }
  return recovered;
}
