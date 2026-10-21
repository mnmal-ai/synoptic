import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  checkBackupFreshness,
  checkBackupOutcome,
  renderBackupOutcomeWarning,
  renderBackupWarning
} from '../src/backup-freshness.js';
import { backupWarning } from '../src/cold-start.js';

function mkBackupDir() {
  return mkdtempSync(join(tmpdir(), 'substrate-backup-test-'));
}

function touch(path, ageHours) {
  writeFileSync(path, 'sql content');
  const t = (Date.now() - ageHours * 3600 * 1000) / 1000;
  utimesSync(path, t, t);
}

test('checkBackupFreshness: fresh — newest dump younger than maxAgeHours', () => {
  const dir = mkBackupDir();
  try {
    touch(join(dir, 'substrate-2026-04-26.sql'), 5);
    touch(join(dir, 'substrate-2026-04-25.sql'), 29);
    const r = checkBackupFreshness({ dir, pattern: /^substrate-.*\.sql$/, maxAgeHours: 30 });
    assert.equal(r.status, 'fresh');
    assert.equal(r.newestFile, 'substrate-2026-04-26.sql');
    assert.ok(r.ageHours >= 4 && r.ageHours <= 6, `ageHours ~5, got ${r.ageHours}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackupFreshness: stale — newest dump older than maxAgeHours', () => {
  const dir = mkBackupDir();
  try {
    touch(join(dir, 'substrate-2026-04-23.sql'), 72);
    const r = checkBackupFreshness({ dir, pattern: /^substrate-.*\.sql$/, maxAgeHours: 30 });
    assert.equal(r.status, 'stale');
    assert.equal(r.newestFile, 'substrate-2026-04-23.sql');
    assert.ok(r.ageHours >= 70 && r.ageHours <= 74);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackupFreshness: missing — directory has no matching files', () => {
  const dir = mkBackupDir();
  try {
    writeFileSync(join(dir, 'backup.log'), 'log content'); // not matching the pattern
    const r = checkBackupFreshness({ dir, pattern: /^substrate-.*\.sql$/, maxAgeHours: 30 });
    assert.equal(r.status, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackupFreshness: error — directory does not exist', () => {
  const r = checkBackupFreshness({
    dir: '/nonexistent-substrate-backup-dir-xyz',
    pattern: /^substrate-.*\.sql$/,
    maxAgeHours: 30
  });
  assert.equal(r.status, 'error');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

test('checkBackupFreshness: ignores non-matching files when picking newest', () => {
  const dir = mkBackupDir();
  try {
    // A newer non-matching file should NOT be picked
    touch(join(dir, 'backup.log'), 1);
    touch(join(dir, 'substrate-2026-04-25.sql'), 12);
    const r = checkBackupFreshness({ dir, pattern: /^substrate-.*\.sql$/, maxAgeHours: 30 });
    assert.equal(r.status, 'fresh');
    assert.equal(r.newestFile, 'substrate-2026-04-25.sql');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderBackupWarning: fresh → empty string (silent)', () => {
  assert.equal(renderBackupWarning({ status: 'fresh', ageHours: 5, newestFile: 'x.sql' }), '');
});

test('renderBackupWarning: stale → ⚠ marker with age + filename', () => {
  const out = renderBackupWarning({
    status: 'stale',
    ageHours: 72,
    newestFile: 'substrate-2026-04-23.sql'
  });
  assert.match(out, /⚠ BACKUP STALE/);
  assert.match(out, /72h/);
  assert.match(out, /substrate-2026-04-23\.sql/);
});

test('renderBackupWarning: missing → ⚠ marker noting no backups found', () => {
  const out = renderBackupWarning({ status: 'missing' });
  assert.match(out, /⚠ BACKUP MISSING/);
});

test('renderBackupWarning: error → ⚠ marker with reason', () => {
  const out = renderBackupWarning({ status: 'error', reason: 'ENOENT: ...' });
  assert.match(out, /⚠ BACKUP CHECK FAILED/);
  assert.match(out, /ENOENT/);
});

// --- opt-in gate (the synoptic-specific wiring) ---

test('backupWarning: off by default — never stats a dir when SYNOPTIC_BACKUP_CHECK unset', () => {
  // dir points at a definitely-stale location; gate-off must still return ''
  assert.equal(backupWarning({ SYNOPTIC_BACKUP_DIR: '/nonexistent-xyz' }), '');
});

test('backupWarning: SYNOPTIC_BACKUP_CHECK=on surfaces a stale warning', () => {
  const dir = mkBackupDir();
  try {
    touch(join(dir, 'app-prod-2026-04-23.sql.gz'), 72);
    const out = backupWarning({
      SYNOPTIC_BACKUP_CHECK: 'on',
      SYNOPTIC_BACKUP_DIR: dir,
      SYNOPTIC_BACKUP_MAX_AGE_HOURS: '30'
    });
    assert.match(out, /⚠ BACKUP STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupWarning: on + fresh dump → silent (empty)', () => {
  const dir = mkBackupDir();
  try {
    touch(join(dir, 'app-prod-2026-04-26.sql.gz'), 2);
    const out = backupWarning({ SYNOPTIC_BACKUP_CHECK: 'on', SYNOPTIC_BACKUP_DIR: dir });
    assert.equal(out, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupWarning: on + default pattern matches any .sql.gz dump', () => {
  const dir = mkBackupDir();
  try {
    touch(join(dir, 'app-prod-2026-04-23.sql.gz'), 100);
    const out = backupWarning({ SYNOPTIC_BACKUP_CHECK: 'on', SYNOPTIC_BACKUP_DIR: dir });
    assert.match(out, /⚠ BACKUP STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkBackupOutcome — the sidecar's own verdict for the LAST attempt.
// Freshness cannot answer "did the last attempt fail": it reads FRESH while
// every new dump is aborting.
// ---------------------------------------------------------------------------

function writeStatus(dir, lines) {
  writeFileSync(join(dir, '.backup-status'), `${lines.join('\n')}\n`);
}

test('checkBackupOutcome: a failed attempt is reported with its stage and error text', () => {
  const dir = mkBackupDir();
  try {
    writeStatus(dir, [
      'outcome=failed',
      'at=2026-09-06T18:13:28Z',
      'db=app_prod',
      'stage=dump',
      'detail=pg_dump: error: Dumping the contents of table "embeddings" failed.'
    ]);
    const r = checkBackupOutcome({ dir });
    assert.equal(r.status, 'failed');
    assert.equal(r.stage, 'dump');
    assert.equal(r.db, 'app_prod');
    assert.match(r.detail, /embeddings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackupOutcome: a successful attempt reports ok and the file it wrote', () => {
  const dir = mkBackupDir();
  try {
    writeStatus(dir, [
      'outcome=ok',
      'at=2026-09-09T14:26:06Z',
      'db=app_prod',
      'stage=dump',
      'detail=',
      'file=app-prod-2026-09-09T142600Z.sql.gz'
    ]);
    const r = checkBackupOutcome({ dir });
    assert.equal(r.status, 'ok');
    assert.equal(r.file, 'app-prod-2026-09-09T142600Z.sql.gz');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackupOutcome: no status file is `absent`, not a failure — older sidecars have none', () => {
  const dir = mkBackupDir();
  try {
    assert.equal(checkBackupOutcome({ dir }).status, 'absent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkBackupOutcome: a file with no verdict is an ERROR, not an all-clear', () => {
  const dir = mkBackupDir();
  try {
    writeStatus(dir, ['at=2026-09-09T14:26:06Z', 'db=app_prod']);
    assert.equal(checkBackupOutcome({ dir }).status, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderBackupOutcomeWarning: silent on ok and on absent, loud on failed', () => {
  assert.equal(
    renderBackupOutcomeWarning({ status: 'ok', at: '', stage: '', detail: '', db: '' }),
    ''
  );
  assert.equal(renderBackupOutcomeWarning({ status: 'absent' }), '');
  const out = renderBackupOutcomeWarning({
    status: 'failed',
    at: '2026-09-06T18:13:28Z',
    stage: 'dump',
    detail: 'PQgetResult() failed.',
    db: 'app_prod'
  });
  assert.match(out, /BACKUP FAILED/);
  assert.match(out, /2026-09-06T18:13:28Z/);
  assert.match(out, /PQgetResult\(\) failed\./);
});

test('backupWarning: a FAILED verdict surfaces even while freshness is passing', () => {
  const dir = mkBackupDir();
  try {
    // A recent dump — freshness alone would say nothing at all.
    touch(join(dir, 'app-prod-2026-09-06T000000Z.sql.gz'), 2);
    writeStatus(dir, [
      'outcome=failed',
      'at=2026-09-06T18:13:28Z',
      'db=app_prod',
      'stage=dump',
      'detail=PQgetResult() failed.'
    ]);
    const env = { SYNOPTIC_BACKUP_CHECK: 'on', SYNOPTIC_BACKUP_DIR: dir };
    const out = backupWarning(env);
    assert.match(out, /BACKUP FAILED/);
    assert.doesNotMatch(out, /BACKUP STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupWarning: both lines render when the last attempt failed AND dumps are stale', () => {
  const dir = mkBackupDir();
  try {
    touch(join(dir, 'app-prod-2026-09-01T000000Z.sql.gz'), 72);
    writeStatus(dir, [
      'outcome=failed',
      'at=2026-09-06T18:13:28Z',
      'db=app_prod',
      'stage=target',
      'detail=marker .substrate-backup-target absent'
    ]);
    const out = backupWarning({ SYNOPTIC_BACKUP_CHECK: 'on', SYNOPTIC_BACKUP_DIR: dir });
    assert.match(out, /BACKUP FAILED/);
    assert.match(out, /BACKUP STALE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backupWarning: on without SYNOPTIC_BACKUP_DIR says so rather than guessing a path', () => {
  assert.match(backupWarning({ SYNOPTIC_BACKUP_CHECK: 'on' }), /SYNOPTIC_BACKUP_DIR is unset/);
});

test('backupWarning: still silent when the check is off, whatever the verdict says', () => {
  const dir = mkBackupDir();
  try {
    writeStatus(dir, ['outcome=failed', 'at=x', 'db=d', 'stage=dump', 'detail=boom']);
    assert.equal(backupWarning({ SYNOPTIC_BACKUP_DIR: dir }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
