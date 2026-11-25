import type { BookmarkNode as ImportedNode } from "../../platform/importModule";
import type { Bookmarks } from "../browser/types";
import { newBookmarkId } from "../bookmarks/bookmarks";
import { pageKey } from "../tabs/pageKeys";

type Nodes = Bookmarks["nodes"];

export type BookmarkMerge = { links: number; folders: number; skipped: number; intoEarlier: boolean };

type Merging = {
  nodes: Nodes;
  before: Nodes;
  seen: ReadonlySet<string>;
  pages: Map<string, ReadonlySet<string>>;
  titled: Map<string, Map<string, string[]>>;
  now: number;
  out: BookmarkMerge;
};

type Place = { id: string; sameNameIsEnough: boolean };

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

function foldersTitled(m: Merging, parentId: string, title: string): string[] {
  let index = m.titled.get(parentId);
  if (!index) {
    index = new Map();
    const parent = m.before[parentId];
    for (const id of parent?.kind === "folder" ? parent.children : []) {
      const child = m.before[id];
      if (child?.kind !== "folder") continue;
      index.set(child.title, [...(index.get(child.title) ?? []), id]);
    }
    m.titled.set(parentId, index);
  }
  return index.get(title) ?? [];
}

export function bookmarkedPages(nodes: Nodes, folderIds: string[]): Set<string> {
  const index: PageIndex = { before: nodes, pages: new Map() };
  return new Set(folderIds.flatMap((id) => [...pagesUnder(index, id)]));
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

function append(m: Merging, parentId: string, nodes: ImportedNode[]) {
  const parent = m.nodes[parentId];
  if (!nodes.length || parent?.kind !== "folder") return;
  const ids = nodes.map((n) => build(m, n, parentId));
  m.nodes[parentId] = { ...parent, children: [...parent.children, ...ids] };
  if (m.before[parentId]?.parentId) m.out.intoEarlier = true;
}

function heldBySource(m: Merging, folderId: string, sourcePages: ReadonlySet<string>): boolean {
  const held = pagesUnder(m, folderId);
  if (!held.size) return !sourcePages.size;
  let shared = 0;
  for (const page of held) if (sourcePages.has(page)) shared += 1;
  return shared * 2 > held.size;
}

function overlap(m: Merging, folderId: string, sourcePages: ReadonlySet<string>): number {
  let shared = 0;
  for (const page of pagesUnder(m, folderId)) if (sourcePages.has(page)) shared += 1;
  return shared;
}

function matchFolders(m: Merging, folders: ImportedNode[], places: Place[]): Map<ImportedNode, string> {
  const pairs: { source: number; folder: string; place: number; candidate: number; shared: number }[] = [];
  folders.forEach((source, s) => {
    const sourcePages = new Set(pagesIn(source.children ?? []));
    places.forEach((place, p) => {
      foldersTitled(m, place.id, source.title).forEach((folder, candidate) => {
        if (!place.sameNameIsEnough && !heldBySource(m, folder, sourcePages)) return;
        pairs.push({ source: s, folder, place: p, candidate, shared: overlap(m, folder, sourcePages) });
      });
    });
  });
  pairs.sort((a, z) => z.shared - a.shared || a.place - z.place || a.source - z.source || a.candidate - z.candidate);
  const matched = new Map<ImportedNode, string>();
  const taken = new Set<string>();
  for (const pair of pairs) {
    const source = folders[pair.source]!;
    if (matched.has(source) || taken.has(pair.folder)) continue;
    matched.set(source, pair.folder);
    taken.add(pair.folder);
  }
  return matched;
}

function mergeLevel(m: Merging, nodes: ImportedNode[], places: Place[]): ImportedNode[] {
  const matched = matchFolders(m, nodes.filter((n) => n.type === "folder"), places);
  const fresh: ImportedNode[] = [];
  for (const n of nodes) {
    const folder = matched.get(n);
    if (folder) append(m, folder, mergeLevel(m, n.children ?? [], [{ id: folder, sameNameIsEnough: true }]));
    else fresh.push(...unseen(m, [n]));
  }
  return fresh;
}

export function mergeImportedBookmarks(nodes: Nodes, seen: ReadonlySet<string>, placements: { rootId: string; nodes: ImportedNode[] }[], wrapperTitle: string): BookmarkMerge {
  const m: Merging = { nodes, before: { ...nodes }, seen, pages: new Map(), titled: new Map(), now: Date.now(), out: { links: 0, folders: 0, skipped: 0, intoEarlier: false } };
  for (const { rootId, nodes: incoming } of placements) {
    const root = m.before[rootId];
    if (!incoming.length || root?.kind !== "folder") continue;
    if (!root.children.length) {
      append(m, rootId, unseen(m, incoming));
      continue;
    }
    const wrapper = foldersTitled(m, rootId, wrapperTitle)[0];
    const places: Place[] = [...(wrapper ? [{ id: wrapper, sameNameIsEnough: true }] : []), { id: rootId, sameNameIsEnough: false }];
    const fresh = mergeLevel(m, incoming, places);
    if (!fresh.length) continue;
    if (wrapper) append(m, wrapper, fresh);
    else append(m, rootId, [{ type: "folder", title: wrapperTitle, children: fresh }]);
  }
  m.out.skipped = placements.reduce((n, p) => n + linkCount(p.nodes), 0) - m.out.links;
  return m.out;
}
