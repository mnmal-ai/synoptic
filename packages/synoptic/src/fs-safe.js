// Filesystem reads that answer null instead of throwing. Every caller treats
// "absent" and "unreadable" alike, so one copy serves them all.

import { readdirSync, readFileSync } from 'node:fs';

/** A file's utf8 text, or null when absent or unreadable. Never throws. */
export function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A directory's entries as Dirents, or null when unreadable. Never throws. */
export function listOrNull(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** The names of a directory's subdirectories, or null when unreadable. Never throws. */
export function listDirsOrNull(path) {
  const entries = listOrNull(path);
  return entries === null ? null : entries.filter((d) => d.isDirectory()).map((d) => d.name);
}
