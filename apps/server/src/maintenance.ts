/**
 * Retention, backups, integrity check and corruption recovery.
 *  - retention: events 30 days by default; opted-in content 7 days (both configurable)
 *  - backups: online SQLite backup API, verified, keep the newest 7
 *  - recovery: a database failing quick_check is moved aside (never deleted) and the newest VALID
 *    backup is restored; otherwise a fresh database is created
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DataDirPaths } from './dataDir.ts';
import { openDb, type DB } from './db/index.ts';
import { getSetting, setSetting } from './store.ts';

// ---------------------------------------------------------------------------- retention
export interface RetentionSettings {
  eventDays: number;
  contentDays: number;
}
export const DEFAULT_RETENTION: RetentionSettings = { eventDays: 30, contentDays: 7 };

export function getRetention(db: DB): RetentionSettings {
  return { ...DEFAULT_RETENTION, ...getSetting<Partial<RetentionSettings>>(db, 'retention', {}) };
}

export function validateRetention(input: unknown): RetentionSettings {
  const r = (input ?? {}) as Record<string, unknown>;
  const eventDays = Number(r.eventDays);
  const contentDays = Number(r.contentDays);
  if (!Number.isInteger(eventDays) || eventDays < 1 || eventDays > 3650) throw new RangeError('eventDays must be 1-3650');
  if (!Number.isInteger(contentDays) || contentDays < 1 || contentDays > 365) throw new RangeError('contentDays must be 1-365');
  if (contentDays > eventDays) throw new RangeError('contentDays cannot exceed eventDays');
  return { eventDays, contentDays };
}

export interface RetentionReport {
  contentCleared: number;
  eventsDeleted: number;
  sessionsDeleted: number;
  notificationsDeleted: number;
  snapshotsDeleted: number;
  authSessionsDeleted: number;
}

export function runRetention(db: DB, now = Date.now()): RetentionReport {
  const { eventDays, contentDays } = getRetention(db);
  const eventCutoff = new Date(now - eventDays * 86_400_000);
  const contentCutoff = new Date(now - contentDays * 86_400_000);
  return db.transaction((): RetentionReport => {
    const contentCleared = db
      .prepare('UPDATE agent_events SET content_json = NULL WHERE content_json IS NOT NULL AND received_at < ?')
      .run(contentCutoff.toISOString()).changes;
    const eventsDeleted = db.prepare('DELETE FROM agent_events WHERE received_at < ?').run(eventCutoff.toISOString()).changes;
    const sessionsDeleted = db.prepare('DELETE FROM sessions WHERE last_event_at < ?').run(eventCutoff.getTime()).changes;
    const notificationsDeleted = db.prepare('DELETE FROM notifications WHERE created_at < ?').run(eventCutoff.toISOString()).changes;
    const snapshotsDeleted = db
      .prepare('DELETE FROM statusline_snapshots WHERE updated_at < ? OR session_id NOT IN (SELECT session_id FROM sessions)')
      .run(eventCutoff.toISOString()).changes;
    const authSessionsDeleted = db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date(now).toISOString()).changes;
    return { contentCleared, eventsDeleted, sessionsDeleted, notificationsDeleted, snapshotsDeleted, authSessionsDeleted };
  })();
}

/** Clears stored opted-in content now (used when a privacy toggle is turned off). */
export function purgeContent(db: DB, kinds: Array<'prompt' | 'toolInput' | 'toolResponse' | 'notificationText'> | 'all'): number {
  const rows = db.prepare('SELECT id, content_json FROM agent_events WHERE content_json IS NOT NULL').all() as Array<{
    id: string;
    content_json: string;
  }>;
  const upd = db.prepare('UPDATE agent_events SET content_json = ? WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (kinds === 'all') {
        upd.run(null, r.id);
        changed++;
        continue;
      }
      let c: Record<string, unknown>;
      try {
        c = JSON.parse(r.content_json) as Record<string, unknown>;
      } catch {
        c = {};
      }
      let touched = false;
      for (const k of kinds) {
        if (k in c) {
          delete c[k];
          touched = true;
        }
      }
      if (touched) {
        upd.run(Object.keys(c).length ? JSON.stringify(c) : null, r.id);
        changed++;
      }
    }
  })();
  return changed;
}

// ---------------------------------------------------------------------------- backups
export const BACKUP_KEEP = 7;
const BACKUP_RE = /^data-\d{8}-\d{6}\.db$/;

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

export function listBackups(paths: DataDirPaths): BackupInfo[] {
  try {
    return fs
      .readdirSync(paths.backups)
      .filter((f) => BACKUP_RE.test(f))
      .sort()
      .reverse()
      .map((name) => {
        const st = fs.statSync(path.join(paths.backups, name));
        return { name, bytes: st.size, createdAt: stampToIso(name) ?? st.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

/** data-YYYYMMDD-HHMMSS.db -> ISO (UTC) */
function stampToIso(name: string): string | null {
  const m = /^data-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

export function checkDbFile(file: string): { ok: boolean; detail: string } {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const detail = rows.map((r) => r.integrity_check).join('; ');
    return { ok: detail === 'ok', detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    db?.close();
  }
}

export async function createBackup(db: DB, paths: DataDirPaths, now = new Date()): Promise<BackupInfo> {
  fs.mkdirSync(paths.backups, { recursive: true });
  const name = `data-${stamp(now)}.db`;
  const dest = path.join(paths.backups, name);
  if (fs.existsSync(dest)) fs.rmSync(dest);
  await db.backup(dest);
  // The copy inherits WAL mode; switch it to a single self-contained file so no -wal/-shm sidecars
  // are ever created next to the backup.
  const copy = new Database(dest);
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
  const check = checkDbFile(dest);
  if (!check.ok) {
    fs.rmSync(dest, { force: true });
    throw new Error(`backup_verification_failed: ${check.detail}`);
  }
  for (const old of listBackups(paths).slice(BACKUP_KEEP)) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(path.join(paths.backups, old.name + ext), { force: true });
  }
  const st = fs.statSync(dest);
  const createdAt = stampToIso(name) ?? st.mtime.toISOString();
  setSetting(db, 'last_backup_at', createdAt);
  return { name, bytes: st.size, createdAt };
}

/** Creates a backup when the newest one is older than 24 h (or none exists). */
export async function maybeDailyBackup(db: DB, paths: DataDirPaths, now = new Date()): Promise<BackupInfo | null> {
  const newest = listBackups(paths)[0];
  if (newest && now.getTime() - Date.parse(newest.createdAt) < 86_400_000) return null;
  return createBackup(db, paths, now);
}

// ---------------------------------------------------------------------------- recovery
export interface RecoveryNotice {
  at: string;
  reason: string;
  restoredFrom: string | null;
}

function moveAside(file: string, suffix: string) {
  for (const ext of ['', '-wal', '-shm']) {
    const f = file + ext;
    if (!fs.existsSync(f)) continue;
    try {
      fs.renameSync(f, `${file}.${suffix}${ext}`);
    } catch {
      fs.rmSync(f, { force: true });
    }
  }
}

/** Opens the database; on corruption moves it aside and restores the newest valid backup. */
export function openDbWithRecovery(paths: DataDirPaths): { db: DB; recovery: RecoveryNotice | null } {
  let reason: string | null = null;
  if (fs.existsSync(paths.db)) {
    try {
      const db = openDb(paths.db);
      const rows = db.pragma('quick_check') as Array<{ quick_check: string }>;
      const detail = rows.map((r) => r.quick_check).join('; ');
      if (detail === 'ok') return { db, recovery: null };
      db.close();
      reason = `quick_check failed: ${detail.slice(0, 200)}`;
    } catch (err) {
      reason = `open failed: ${(err as Error).message.slice(0, 200)}`;
    }
    moveAside(paths.db, `corrupt-${Date.now()}`);
  }
  let restoredFrom: string | null = null;
  if (reason) {
    for (const b of listBackups(paths)) {
      const src = path.join(paths.backups, b.name);
      if (!checkDbFile(src).ok) continue;
      fs.copyFileSync(src, paths.db);
      restoredFrom = b.name;
      break;
    }
  }
  const db = openDb(paths.db);
  const recovery = reason ? { at: new Date().toISOString(), reason, restoredFrom } : null;
  if (recovery) setSetting(db, 'recovery_notice', recovery);
  return { db, recovery };
}

export function integrityCheck(db: DB): { ok: boolean; detail: string } {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const detail = rows.map((r) => r.integrity_check).join('; ');
  return { ok: detail === 'ok', detail };
}

/** Replaces the live database with a verified backup (server must be stopped). */
export function restoreBackup(paths: DataDirPaths, name: string): void {
  if (!BACKUP_RE.test(name)) throw new Error('invalid_backup_name');
  const src = path.join(paths.backups, name);
  if (!fs.existsSync(src)) throw new Error('backup_not_found');
  const check = checkDbFile(src);
  if (!check.ok) throw new Error(`backup_invalid: ${check.detail}`);
  moveAside(paths.db, `before-restore-${Date.now()}`);
  fs.copyFileSync(src, paths.db);
}
