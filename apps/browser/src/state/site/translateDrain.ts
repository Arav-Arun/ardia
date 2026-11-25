export type Passage = [number, [number, string][]];
export type Translated = [number, string | null];
export type PageBatch = { passages: unknown[]; more: boolean; gone: boolean; done: number; total: number };

export const PACK_CHARS = 600;
export const FIRST_PACK_CHARS = 60;
export const PACK_PASSAGES = 24;
export const FAILED_PACKS_IN_A_ROW = 3;
export const LONG_PASSAGE = 200;

type DrainPort = {
  inFlight: number;
  holds(): boolean;
  released: Promise<void>;
  next(maxChars: number): Promise<PageBatch | null | undefined>;
  translate(pack: Passage[]): Promise<Translated[]>;
  apply(results: Translated[]): Promise<unknown>;
  onStage?(stage: "collect" | "model" | "apply"): void;
  onApplied?(passages: number, total: number): void;
  onFailed?(passages: number): void;
};

const MAX_PIECES = 40;

const cleanPassages = (passages: unknown[]): Passage[] =>
  passages
    .filter((p): p is Passage => Array.isArray(p) && typeof p[0] === "number" && Array.isArray(p[1]))
    .map(([id, pieces]): Passage => [id, pieces.filter((x) => Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "string").slice(0, MAX_PIECES)])
    .filter(([, pieces]) => pieces.length > 0);

const sizeOf = ([, pieces]: Passage) => pieces.reduce((n, [, text]) => n + text.length, 0);

export function packsOf(passages: Passage[]): Passage[][] {
  const packs: Passage[][] = [];
  let short: Passage[] = [];
  for (const passage of passages) {
    if (sizeOf(passage) < LONG_PASSAGE) {
      short.push(passage);
      continue;
    }
    if (short.length) packs.push(short);
    short = [];
    packs.push([passage]);
  }
  if (short.length) packs.push(short);
  return packs;
}

const untranslated = ([, pieces]: Passage): Translated[] => pieces.map(([id]): Translated => [id, null]);

export async function drainPassages(port: DrainPort): Promise<boolean> {
  const running = new Set<Promise<void>>();
  const backlog: Passage[][] = [];
  let failure: { error: unknown } | null = null;
  let lastError: { error: unknown } | null = null;
  let failedInARow = 0;
  let succeeded = 0;
  let total = 0;
  let exhausted = false;
  let asked = false;
  let released = false;
  void port.released.then(() => (released = true));
  const live = () => !released && port.holds();
  const settle = async () => {
    await Promise.race([Promise.allSettled(running), port.released]);
    if (!live()) return false;
    if (failure) throw failure.error;
    if (!succeeded && lastError) throw lastError.error;
    return true;
  };
  const start = (pack: Passage[]) => {
    const job = port
      .translate(pack)
      .then(
        async (results) => {
          if (!live()) return;
          failedInARow = 0;
          succeeded++;
          port.onStage?.("apply");
          await port.apply(results);
          if (live()) port.onApplied?.(pack.length, total);
        },
        async (error: unknown) => {
          if (!live()) return;
          lastError = { error };
          port.onFailed?.(pack.length);
          if (++failedInARow >= FAILED_PACKS_IN_A_ROW) failure ??= { error };
          await port.apply(pack.flatMap(untranslated)).catch(() => {});
        },
      )
      .catch((error: unknown) => {
        if (live()) failure ??= { error };
      })
      .finally(() => running.delete(job));
    running.add(job);
  };
  for (;;) {
    if (!live()) return false;
    if (failure) return settle();
    while (running.size < port.inFlight && backlog.length) start(backlog.shift()!);
    if (running.size < port.inFlight && !exhausted) {
      port.onStage?.("collect");
      const batch = await port.next(asked ? PACK_CHARS : FIRST_PACK_CHARS);
      asked = true;
      if (!live()) return false;
      if (!batch || batch.gone || !Array.isArray(batch.passages)) return false;
      total = batch.total;
      exhausted = !batch.more;
      backlog.push(...packsOf(cleanPassages(batch.passages)));
      if (backlog.length) {
        port.onStage?.("model");
        continue;
      }
    }
    if (!running.size && !backlog.length) return settle();
    await Promise.race([...running, port.released]);
    exhausted = false;
  }
}
