import { canonical } from "./canon.ts";
import { ABSENT, fingerprint, launchOf, queueRecovered } from "./applyBatches.ts";
import { dropBase, putBase, visible } from "./scopeKeys.ts";
import type { ApplyBatch, Extraction, ScopeOptions, ScopeState } from "./scopeState.ts";

type Step = { at: number; from: string; to: string };
export type ExtractWith = (baseJson: (key: string) => string | undefined) => Promise<Extraction | null>;

const nativeJson = (extraction: Extraction, key: string) => {
  if (!extraction.values.has(key)) return ABSENT;
  const value = extraction.values.get(key);
  return extraction.json?.(key, value) ?? canonical(value);
};

function setBase(state: ScopeState, key: string, json: string) {
  if (json === ABSENT) dropBase(state, key);
  else putBase(state, key, json);
}

function chainsOf(batches: ApplyBatch[], skip: (key: string) => boolean) {
  const chains = new Map<string, Step[]>();
  batches.forEach((batch, at) => {
    for (const [key, [from, to]] of Object.entries(batch.k)) {
      if (skip(key)) continue;
      let chain = chains.get(key);
      if (!chain) chains.set(key, (chain = []));
      chain.push({ at, from: from ?? ABSENT, to });
    }
  });
  return chains;
}

function knownJson(state: ScopeState, key: string, chain: Step[], fp: string): string | undefined {
  const record = state.records[key];
  const candidates = [state.base[key] ?? ABSENT, ...(record ? [canonical(record.v)] : []), ...chain.map((s) => s.from)];
  return candidates.find((json) => fingerprint(json) === fp);
}

function lastBefore(chain: Step[], hypothesis: number): Step | undefined {
  let last: Step | undefined;
  for (const step of chain) if (step.at < hypothesis) last = step;
  return last;
}

function fpAt(chain: Step[], hypothesis: number): string {
  const last = lastBefore(chain, hypothesis);
  return last ? last.to : fingerprint(chain[0]!.from);
}

function jsonAt(state: ScopeState, key: string, chain: Step[], hypothesis: number): string | undefined {
  const last = lastBefore(chain, hypothesis);
  return last ? knownJson(state, key, chain, last.to) : chain[0]!.from;
}

type Trial = { hypothesis: number; extraction: Extraction; matches: number; baseJson: (key: string) => string | undefined };

async function tryHypothesis(state: ScopeState, chains: Map<string, Step[]>, hypothesis: number, first: Extraction, extractWith: ExtractWith): Promise<Trial | null> {
  const overrides = new Map<string, string>();
  for (const [key, chain] of chains) {
    const json = jsonAt(state, key, chain, hypothesis);
    if (json !== undefined) overrides.set(key, json);
  }
  const baseJson = (key: string) => {
    const json = overrides.has(key) ? overrides.get(key)! : state.base[key];
    return json === ABSENT ? undefined : json;
  };
  const same = [...overrides].every(([key, json]) => (state.base[key] ?? ABSENT) === json);
  const extraction = same ? first : await extractWith(baseJson);
  if (!extraction) return null;
  let matches = 0;
  for (const [key, chain] of chains) {
    if (extraction.ignore?.(key)) continue;
    if (fingerprint(nativeJson(extraction, key)) === fpAt(chain, hypothesis)) matches++;
  }
  return { hypothesis, extraction, matches, baseJson };
}

function keepUnresolved(state: ScopeState, batches: ApplyBatch[], resolved: Set<string>) {
  const kept: ApplyBatch[] = [];
  for (const batch of state.applying ?? []) {
    if (!batches.includes(batch)) {
      kept.push(batch);
      continue;
    }
    const left = Object.entries(batch.k).filter(([key]) => !resolved.has(key));
    if (left.length) kept.push({ ...batch, r: 1, k: Object.fromEntries(left) });
  }
  if (kept.length) state.applying = kept;
  else delete state.applying;
}

export async function recoverBatches(state: ScopeState, prefix: string, first: Extraction, extractWith: ExtractWith, options: ScopeOptions = {}): Promise<Extraction | null> {
  const launch = launchOf(options);
  const batches = (state.applying ?? []).filter((b) => b.p === prefix && b.l !== launch).sort((a, z) => a.id - z.id);
  if (!batches.length) return first;
  const chains = chainsOf(batches, (key) => !!first.ignore?.(key));
  if (!chains.size) {
    keepUnresolved(state, batches, new Set());
    return first;
  }
  let best: Trial | null = null;
  for (let hypothesis = 0; hypothesis <= batches.length; hypothesis++) {
    const trial = await tryHypothesis(state, chains, hypothesis, first, extractWith);
    if (!trial) return null;
    if (!best || trial.matches > best.matches) best = trial;
  }
  const { extraction, hypothesis, baseJson } = best!;
  const view = visible(state, prefix);
  const sinceRestart = chainsOf((state.applying ?? []).filter((b) => b.p === prefix && b.l === launch), (key) => !chains.has(key));
  const resolved = new Set<string>();
  const queue: string[] = [];
  for (const [key, chain] of chains) {
    if (extraction.ignore?.(key)) continue;
    resolved.add(key);
    const actual = nativeJson(extraction, key);
    const fp = fingerprint(actual);
    const explained = fp === fpAt(chain, hypothesis) || chain.some((s) => s.to === fp || fingerprint(s.from) === fp) || !!sinceRestart.get(key)?.some((s) => s.to === fp || fingerprint(s.from) === fp);
    if (!explained) {
      setBase(state, key, baseJson(key) ?? ABSENT);
      continue;
    }
    setBase(state, key, actual);
    const target = view.has(key) ? canonical(view.get(key)) : ABSENT;
    if (actual !== target) queue.push(key);
  }
  keepUnresolved(state, batches, resolved);
  queueRecovered(state, queue);
  return extraction;
}
