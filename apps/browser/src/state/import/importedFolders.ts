import { readDocument, writeDocument } from "../../platform/documents";
import { isFields, isString } from "../../lib/decode";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import type { ImportedFolder, ImportedFolders } from "./bookmarkMerge";

export const IMPORTED_FOLDERS_DOCUMENT = "imported-bookmarks.json";

const VERSION = 1;
const MIGRATIONS: Migrations = { 0: unchanged };

const folderFrom = (saved: unknown): ImportedFolder | null => {
  if (!isFields(saved) || !isString(saved.source) || !isString(saved.engine)) return null;
  return { source: saved.source, engine: saved.engine, ...(saved.wrapper === true ? { wrapper: true as const } : {}) };
};

export function readImportedFolders(): ImportedFolders {
  try {
    const doc = parseSaved(readDocument(IMPORTED_FOLDERS_DOCUMENT), VERSION, MIGRATIONS);
    if (!doc || !isFields(doc.folders)) return {};
    const out: ImportedFolders = {};
    for (const [id, saved] of Object.entries(doc.folders)) {
      const folder = folderFrom(saved);
      if (folder) out[id] = folder;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveImportedFolders(folders: ImportedFolders) {
  try {
    writeDocument(IMPORTED_FOLDERS_DOCUMENT, versionedJson({ folders }, VERSION));
  } catch (error) {
    console.warn("Couldn't save which bookmark folders imports made", error);
  }
}
