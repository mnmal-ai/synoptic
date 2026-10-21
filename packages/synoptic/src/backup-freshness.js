// Backup-freshness watchdog. Pure function over a backup directory —
// reads the newest matching file's mtime and reports whether it's within
// the configured age window. Renders a one-line warning marker for the
// SessionStart hook to inject into context. No I/O beyond the directory
// listing; no Substrate dependency.
//
// Lesson from v1 retirement: the v1 backup cron silently failed for
// 14 days (container-name regression). Same failure mode is possible
// on v2. The cold-start hook is the alert channel for this workflow —
// if the watchdog says stale, the next session sees the warning.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @returns {{ status: 'fresh' | 'stale', ageHours: number, newestFile: string }
 *          | { status: 'missing' }
 *          | { status: 'error', reason: string }}
 */
export function checkBackupFreshness({ dir, pattern, maxAgeHours, now = Date.now() }) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return { status: 'error', reason: e.message ?? String(e) };
  }

  let newestFile = null;
  let newestMs = -1;
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    let st;
    try {
      st = statSync(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ms = st.mtimeMs;
    if (ms > newestMs) {
      newestMs = ms;
      newestFile = name;
    }
  }

  if (newestFile === null) return { status: 'missing' };

  const ageHours = (now - newestMs) / (3600 * 1000);
  return {
    status: ageHours > maxAgeHours ? 'stale' : 'fresh',
    ageHours,
    newestFile
  };
}

// The verdict of the LAST backup attempt, as recorded by the sidecar's
// `write_status`.
//
// Freshness answers "has anything landed lately". It cannot answer "did the
// last attempt fail": pg_dump can fail every attempt while the newest dump is
// still inside the age window, and the freshness watchdog stays correctly
// silent. Age is a lagging proxy for a failure
// the component already detected and reported.
//
// The file is `key=value` lines, latest attempt only — a verdict, not a log.
//
// @returns {{ status: 'ok' | 'failed', at: string, stage: string, detail: string,
//             db: string, file?: string }
//          | { status: 'absent' }
//          | { status: 'error', reason: string }}
export function checkBackupOutcome({ dir, statusFile = '.backup-status' }) {
  let raw;
  try {
    raw = readFileSync(join(dir, statusFile), 'utf8');
  } catch (e) {
    // ENOENT is the ordinary case on a host whose sidecar predates the status
    // file, so it is reported as `absent` and rendered silently. Freshness
    // still covers those hosts; warning here would fire on every cold start
    // across the fleet and train the reader to ignore the line that matters.
    if (e?.code === 'ENOENT') return { status: 'absent' };
    return { status: 'error', reason: e.message ?? String(e) };
  }

  const fields = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }

  // A file that exists but carries no verdict is not an all-clear. It means a
  // writer got partway, which is a different fault from never having run.
  if (fields.outcome !== 'ok' && fields.outcome !== 'failed') {
    return { status: 'error', reason: `unparseable status file (outcome=${fields.outcome ?? ''})` };
  }

  return {
    status: fields.outcome,
    at: fields.at ?? '',
    stage: fields.stage ?? '',
    detail: fields.detail ?? '',
    db: fields.db ?? '',
    ...(fields.file ? { file: fields.file } : {})
  };
}

/**
 * Render a one-line warning marker for the last-attempt verdict.
 * Silent when the last attempt succeeded, and when no verdict is recorded.
 */
export function renderBackupOutcomeWarning(result) {
  if (result.status === 'ok' || result.status === 'absent') return '';
  if (result.status === 'failed') {
    const when = result.at ? ` at ${result.at}` : '';
    const why = result.detail ? ` — ${result.detail}` : '';
    return `⚠ BACKUP FAILED${when} (stage: ${result.stage})${why}\n  The sidecar reported this itself; it is not inferred from backup age. \`docker compose logs postgres-backup\`.\n\n`;
  }
  return `⚠ BACKUP STATUS UNREADABLE: ${result.reason}\n\n`;
}

/**
 * Render a one-line warning marker for the cold-start hook output.
 * Returns empty string when fresh — silent on the happy path.
 */
export function renderBackupWarning(result) {
  if (result.status === 'fresh') return '';
  if (result.status === 'stale') {
    const age = Math.round(result.ageHours);
    return `⚠ BACKUP STALE: newest dump is ${age}h old (${result.newestFile}). Cron may have stopped firing — check \`tail data/backups/backup.log\`.\n\n`;
  }
  if (result.status === 'missing') {
    return `⚠ BACKUP MISSING: no backup files found in the configured directory. Cron may never have run, or files were moved/deleted.\n\n`;
  }
  return `⚠ BACKUP CHECK FAILED: ${result.reason}\n\n`;
}
