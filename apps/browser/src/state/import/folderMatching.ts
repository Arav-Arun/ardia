export type FolderEdge = { source: number; candidate: number; shared: number };

const CARDINALITY_FIRST = 1_000_000;
const EXACT_LIMIT = 4096;

function exactPairs(rows: number[], cols: number[], weight: (row: number, col: number) => number): [number, number][] {
  const transposed = rows.length > cols.length;
  const r = transposed ? cols : rows;
  const c = transposed ? rows : cols;
  const at = (i: number, j: number) => (transposed ? weight(c[j]!, r[i]!) : weight(r[i]!, c[j]!));
  const n = r.length;
  const m = c.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const owner = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    owner[0] = i;
    let j0 = 0;
    const least = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = owner[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cost = -at(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cost < least[j]!) {
          least[j] = cost;
          way[j] = j0;
        }
        if (least[j]! < delta) {
          delta = least[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[owner[j]!] = u[owner[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else least[j] = least[j]! - delta;
      }
      j0 = j1;
    } while (owner[j0] !== 0);
    do {
      const j1 = way[j0]!;
      owner[j0] = owner[j1]!;
      j0 = j1;
    } while (j0);
  }
  const out: [number, number][] = [];
  for (let j = 1; j <= m; j++) {
    const i = owner[j]!;
    if (!i || at(i - 1, j - 1) <= 0) continue;
    out.push(transposed ? [c[j - 1]!, r[i - 1]!] : [r[i - 1]!, c[j - 1]!]);
  }
  return out;
}

function greedyPairs(edges: FolderEdge[]): [number, number][] {
  const sorted = [...edges].sort((a, z) => z.shared - a.shared || a.source - z.source || a.candidate - z.candidate);
  const sources = new Set<number>();
  const candidates = new Set<number>();
  const out: [number, number][] = [];
  for (const e of sorted) {
    if (sources.has(e.source) || candidates.has(e.candidate)) continue;
    sources.add(e.source);
    candidates.add(e.candidate);
    out.push([e.source, e.candidate]);
  }
  return out;
}

export function pairFolders(sourceCount: number, candidateCount: number, edges: FolderEdge[]): number[] {
  const parent = Array.from({ length: sourceCount + candidateCount }, (_, i) => i);
  const root = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (const e of edges) parent[root(e.source)] = root(sourceCount + e.candidate);
  const groups = new Map<number, FolderEdge[]>();
  for (const e of edges) {
    const key = root(e.source);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const paired = new Array<number>(sourceCount).fill(-1);
  for (const group of groups.values()) {
    const rows = [...new Set(group.map((e) => e.source))].sort((a, z) => a - z);
    const cols = [...new Set(group.map((e) => e.candidate))].sort((a, z) => a - z);
    const weights = new Map(group.map((e) => [`${e.source}:${e.candidate}`, CARDINALITY_FIRST + e.shared]));
    const pairs = rows.length * cols.length <= EXACT_LIMIT ? exactPairs(rows, cols, (s, c) => weights.get(`${s}:${c}`) ?? 0) : greedyPairs(group);
    for (const [source, candidate] of pairs) paired[source] = candidate;
  }
  const taken = new Set(paired.filter((c) => c >= 0));
  let next = 0;
  for (let s = 0; s < sourceCount; s++) {
    if (paired[s]! >= 0) continue;
    while (next < candidateCount && taken.has(next)) next++;
    if (next >= candidateCount) break;
    paired[s] = next;
    taken.add(next);
  }
  return paired;
}
