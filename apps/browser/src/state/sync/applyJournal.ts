import { emptyScope, validBatches, type ApplyBatch, type ScopeState } from "../../platform/sync";
import { isFields } from "../../lib/decode";
import type { SyncDoc } from "./syncDoc";

export type ApplyingByScope = Record<string, ApplyBatch[]>;
export type ScopeRest = Partial<ScopeState> & { applyingIds?: number[] };

export const APPLYING_PART_CHARS = 1_000_000;

const isIdList = (v: unknown): v is number[] => Array.isArray(v) && v.every((id) => typeof id === "number" && Number.isFinite(id));

export function restOf(state: ScopeState): ScopeRest {
  const { records: _records, base: _base, applying, ...rest } = state;
  return applying?.length ? { ...rest, applyingIds: applying.map((b) => b.id) } : rest;
}

export function scopeFromRest(rest: unknown, records: ScopeState["records"], base: ScopeState["base"], before: ScopeState | undefined): ScopeState {
  const { applying: _applying, applyingIds, ...kept } = (isFields(rest) ? rest : {}) as ScopeRest;
  const scoped: ScopeState = { ...emptyScope(), ...kept, records, base };
  const ids = isIdList(applyingIds) ? new Set(applyingIds) : null;
  const batches = ids ? (before?.applying ?? []).filter((b) => ids.has(b.id)) : [];
  if (batches.length) scoped.applying = batches;
  return scoped;
}

export function savedScope(scope: Record<string, unknown>): ScopeState {
  const { applyingIds: _ids, ...saved } = scope;
  const scoped: ScopeState = { ...emptyScope(), ...(saved as Partial<ScopeState>) };
  const batches = validBatches(saved.applying);
  if (batches.length) scoped.applying = batches;
  else delete scoped.applying;
  return scoped;
}

export function replayApplying(scopes: SyncDoc["scopes"], applying: unknown, live: Set<string>) {
  if (!isFields(applying)) return;
  for (const [scope, list] of Object.entries(applying)) {
    if (!live.has(scope)) continue;
    const batches = validBatches(list);
    if (!batches.length) continue;
    const scoped = (scopes[scope] ??= emptyScope());
    const known = [...(scoped.applying ?? [])];
    for (const batch of batches) {
      const at = known.findIndex((b) => b.id === batch.id);
      if (at < 0) known.push({ ...batch, k: { ...batch.k } });
      else known[at] = { ...known[at]!, k: { ...known[at]!.k, ...batch.k } };
    }
    scoped.applying = known.sort((a, z) => a.id - z.id);
  }
}

export function chunksOf(batch: ApplyBatch, limit = APPLYING_PART_CHARS): ApplyBatch[] {
  const chunks: ApplyBatch[] = [];
  let keys: ApplyBatch["k"] = {};
  let size = 0;
  for (const [key, step] of Object.entries(batch.k)) {
    const entry = JSON.stringify(key).length + JSON.stringify(step).length + 2;
    if (size && size + entry > limit) {
      chunks.push({ ...batch, k: keys });
      keys = {};
      size = 0;
    }
    keys[key] = step;
    size += entry;
  }
  chunks.push({ ...batch, k: keys });
  return chunks;
}

export const holdsApplying = (scopes: SyncDoc["scopes"]) => Object.values(scopes).some((scoped) => scoped.applying?.some((b) => !b.r));
