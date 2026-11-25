import type { BookmarkNode as ImportedNode } from "../../platform/importModule";
import type { Bookmarks } from "../browser/types";
import { newBookmarkId } from "../bookmarks/bookmarks";
import { pageKey } from "../tabs/pageKeys";
import { pairFolders, type FolderEdge } from "./folderMatching";

type Nodes = Bookmarks["nodes"];

export type ImportedFolder = { source: string; engine: string; wrapper?: true; adopted?: true };
export type ImportedFolders = Record<string, ImportedFolder>;

export type BookmarkMerge = { links: number; folders: number; skipped: number; intoEarlier: boolean; made: ImportedFolders };

type Merging = {
  nodes: Nodes;
  before: Nodes;
  seen: ReadonlySet<string>;
  pages: Map<string, ReadonlySet<string>>;
  ownsNested: (folderId: string) => boolean;
  now: number;
  out: BookmarkMerge;
};

type Place = { id: string; earlier: boolean; takes: (folderId: string) => boolean };
type Candidate = { id: string; earlier: boolean };

const RARE_PAGE_HOLDERS = 16;
const EDGE_WORK_BUDGET = 500_000;

function countedPages(pagesOf: string[][], holders: ReadonlyMap<string, number[]>): Set<string> {
  const uses = new Map<string, number>();
  for (const pages of pagesOf) for (const page of pages) if (holders.has(page)) uses.set(page, (uses.get(page) ?? 0) + 1);
  const byCost = [...uses].map(([page, n]) => ({ page, held: holders.get(page)!.length, cost: n * holders.get(page)!.length })).sort((a, z) => a.held - z.held || (a.page < z.page ? -1 : 1));
  const counted = new Set<string>();
  let work = 0;
  for (const { page, held, cost } of byCost) {
    if (held > RARE_PAGE_HOLDERS && work + cost > EDGE_WORK_BUDGET) break;
    work += cost;
    counted.add(page);
  }
  return counted;
}

const pagesIn = (nodes: ImportedNode[]): string[] =>
  nodes.flatMap((n) => (n.type === "folder" ? pagesIn(n.children ?? []) : n.url ? [pageKey(n.url)] : []));

const linkCount = (nodes: ImportedNode[]): number => nodes.reduce((n, c) => n + (c.type === "url" ? 1 : linkCount(c.children ?? [])), 0);

type PageIndex = Pick<Merging, "before" | "pages">;

function pagesUnder(m: PageIndex, id: string): ReadonlySet<string> {
  const known = m.pages.get(id);
  if (known) return known;
  const node = m.before[id];
  const out = new Set<string>();
  m.pages.set(id, out);
  if (node?.kind === "url") out.add(pageKey(node.url));
  else if (node) for (const child of node.children) for (const page of pagesUnder(m, child)) out.add(page);
  return out;
}

export function bookmarkedPages(nodes: Nodes, folderIds: string[]): Set<string> {
  const index: PageIndex = { before: nodes, pages: new Map() };
  return new Set(folderIds.flatMap((id) => [...pagesUnder(index, id)]));
}

function childFolders(m: Merging, place: Place): Candidate[] {
  const parent = m.before[place.id];
  if (parent?.kind !== "folder") return [];
  return parent.children.filter((id) => m.before[id]?.kind === "folder" && place.takes(id)).map((id) => ({ id, earlier: place.earlier }));
}

function unseen(m: Merging, nodes: ImportedNode[]): ImportedNode[] {
  return nodes.flatMap((n): ImportedNode[] => {
    if (n.type === "url") return n.url && m.seen.has(pageKey(n.url)) ? [] : [n];
    const children = unseen(m, n.children ?? []);
    return children.length || !n.children?.length ? [{ ...n, children }] : [];
  });
}

function build(m: Merging, n: ImportedNode, parentId: string): string {
  const id = newBookmarkId();
  const addedAt = n.dateAdded ?? m.now;
  if (n.type === "url") {
    m.nodes[id] = { kind: "url", id, parentId, title: n.title ?? n.url ?? "", url: n.url ?? "", favicon: null, addedAt };
    m.out.links += 1;
  } else {
    m.nodes[id] = { kind: "folder", id, parentId, title: n.title, children: (n.children ?? []).map((c) => build(m, c, id)), addedAt };
    m.out.folders += 1;
  }
  return id;
}

function append(m: Merging, parentId: string, nodes: ImportedNode[], earlier: boolean): string[] {
  const parent = m.nodes[parentId];
  if (!nodes.length || parent?.kind !== "folder") return [];
  const ids = nodes.map((n) => build(m, n, parentId));
  m.nodes[parentId] = { ...parent, children: [...parent.children, ...ids] };
  if (earlier) m.out.intoEarlier = true;
  return ids;
}

function matchFolders(m: Merging, folders: ImportedNode[], places: Place[]): Map<ImportedNode, Candidate> {
  const byTitle = new Map<string, { sources: ImportedNode[]; candidates: Candidate[] }>();
  const group = (title: string) => {
    let g = byTitle.get(title);
    if (!g) byTitle.set(title, (g = { sources: [], candidates: [] }));
    return g;
  };
  for (const source of folders) group(source.title).sources.push(source);
  for (const place of places) for (const c of childFolders(m, place)) byTitle.get(m.before[c.id]?.title ?? "")?.candidates.push(c);
  const matched = new Map<ImportedNode, Candidate>();
  for (const { sources, candidates } of byTitle.values()) {
    if (!candidates.length) continue;
    const holders = new Map<string, number[]>();
    candidates.forEach((c, i) => {
      for (const page of pagesUnder(m, c.id)) {
        const list = holders.get(page);
        if (list) list.push(i);
        else holders.set(page, [i]);
      }
    });
    const pagesOf = sources.map((source) => [...new Set(pagesIn(source.children ?? []))]);
    const counted = countedPages(pagesOf, holders);
    const edges: FolderEdge[] = [];
    pagesOf.forEach((pages, s) => {
      const shared = new Map<number, number>();
      for (const page of pages) {
        if (!counted.has(page)) continue;
        for (const c of holders.get(page) ?? []) shared.set(c, (shared.get(c) ?? 0) + 1);
      }
      for (const [candidate, count] of shared) edges.push({ source: s, candidate, shared: count });
    });
    pairFolders(sources.length, candidates.length, edges).forEach((c, s) => {
      if (c >= 0) matched.set(sources[s]!, candidates[c]!);
    });
  }
  return matched;
}

function mergeLevel(m: Merging, nodes: ImportedNode[], places: Place[]): ImportedNode[] {
  const matched = matchFolders(m, nodes.filter((n) => n.type === "folder"), places);
  const fresh: ImportedNode[] = [];
  for (const n of nodes) {
    const folder = matched.get(n);
    if (!folder) {
      fresh.push(...unseen(m, [n]));
      continue;
    }
    const inner = mergeLevel(m, n.children ?? [], [{ id: folder.id, earlier: folder.earlier, takes: m.ownsNested }]);
    append(m, folder.id, inner, folder.earlier);
  }
  return fresh;
}

export function mergeImportedBookmarks(
  nodes: Nodes,
  seen: ReadonlySet<string>,
  placements: { rootId: string; nodes: ImportedNode[] }[],
  from: { source: string; engine: string; made: ImportedFolders },
): BookmarkMerge {
  const ours = (id: string) => from.made[id]?.source === from.source;
  const ownsNested = (id: string) => !from.made[id] || (ours(id) && !from.made[id]!.wrapper);
  const m: Merging = { nodes, before: { ...nodes }, seen, pages: new Map(), ownsNested, now: Date.now(), out: { links: 0, folders: 0, skipped: 0, intoEarlier: false, made: {} } };
  const record = (id: string, kind: { wrapper?: boolean; adopted?: boolean }) =>
    (m.out.made[id] = { source: from.source, engine: from.engine, ...(kind.wrapper ? { wrapper: true as const } : {}), ...(kind.adopted ? { adopted: true as const } : {}) });
  const wrapperTitle = `Imported from ${from.source}`;
  for (const { rootId, nodes: incoming } of placements) {
    const root = m.before[rootId];
    if (!incoming.length || root?.kind !== "folder") continue;
    if (!root.children.length) {
      for (const id of append(m, rootId, unseen(m, incoming), false)) if (m.nodes[id]?.kind === "folder") record(id, {});
      continue;
    }
    const folders = root.children.filter((id) => m.before[id]?.kind === "folder");
    const recorded = folders.find((id) => ours(id) && from.made[id]!.wrapper);
    const adopted = recorded ? undefined : folders.find((id) => !from.made[id] && m.before[id]!.title === wrapperTitle);
    const wrapper = recorded ?? adopted;
    if (adopted) record(adopted, { wrapper: true, adopted: true });
    const madeByImport = !!recorded && !from.made[recorded]!.adopted;
    const places: Place[] = [
      ...(wrapper ? [{ id: wrapper, earlier: madeByImport, takes: ownsNested }] : []),
      { id: rootId, earlier: true, takes: (id: string) => ours(id) && !from.made[id]!.wrapper },
    ];
    const fresh = mergeLevel(m, incoming, places);
    if (!fresh.length) continue;
    if (wrapper) append(m, wrapper, fresh, madeByImport);
    else for (const id of append(m, rootId, [{ type: "folder", title: wrapperTitle, children: fresh }], false)) record(id, { wrapper: true });
  }
  m.out.skipped = placements.reduce((n, p) => n + linkCount(p.nodes), 0) - m.out.links;
  return m.out;
}
