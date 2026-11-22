/**
 * Replay of the forwarder's sanitized spool (events produced while the collector was down).
 *  - the live file is renamed to `spool.processing.<ts>.jsonl` first, so forwarders keep appending
 *    to a fresh `spool.jsonl` and nothing is read twice or lost;
 *  - events are applied in timestamp order (stable for ties), each through the normal `ingest`
 *    pipeline with origin "replay" (strict schema validation + dedupe by eventId => exactly once);
 *  - a crash mid-replay leaves the processing file behind; the next run re-reads it and dedupe
 *    skips what was already stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ingest, ValidationError, type Broadcast } from './collector.ts';
import type { DataDirPaths } from './dataDir.ts';
import type { DB } from './db/index.ts';

export interface ReplayReport {
  files: number;
  lines: number;
  applied: number;
  duplicates: number;
  invalid: number;
}

const PROCESSING_RE = /^spool\.processing\.\d+\.jsonl$/;

export function spoolStatus(paths: DataDirPaths): { pendingEvents: number; pendingBytes: number } {
  let pendingBytes = 0;
  let pendingEvents = 0;
  const files = [paths.spool];
  try {
    for (const f of fs.readdirSync(paths.root)) if (PROCESSING_RE.test(f)) files.push(path.join(paths.root, f));
  } catch {
    /* ignore */
  }
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      pendingBytes += Buffer.byteLength(text);
      pendingEvents += text.split('\n').filter((l) => l.trim()).length;
    } catch {
      /* missing */
    }
  }
  return { pendingEvents, pendingBytes };
}

export function replaySpool(db: DB, paths: DataDirPaths, broadcast: Broadcast): ReplayReport {
  const report: ReplayReport = { files: 0, lines: 0, applied: 0, duplicates: 0, invalid: 0 };

  // 1) claim the live spool (rename can transiently fail while a forwarder has it open: retry next tick)
  if (fs.existsSync(paths.spool)) {
    const claimed = path.join(paths.root, `spool.processing.${Date.now()}.jsonl`);
    try {
      fs.renameSync(paths.spool, claimed);
    } catch {
      /* try again on the next tick */
    }
  }

  // 2) process every claimed file (oldest first)
  const processing = fs
    .readdirSync(paths.root)
    .filter((f) => PROCESSING_RE.test(f))
    .sort();
  for (const name of processing) {
    const file = path.join(paths.root, name);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    report.files++;
    const events: Array<{ ts: number; seq: number; body: unknown }> = [];
    text.split('\n').forEach((line, seq) => {
      if (!line.trim()) return;
      report.lines++;
      try {
        const body = JSON.parse(line) as { ts?: unknown };
        events.push({ ts: typeof body.ts === 'string' ? Date.parse(body.ts) || 0 : 0, seq, body });
      } catch {
        report.invalid++;
      }
    });
    events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    for (const e of events) {
      try {
        const r = ingest(db, e.body, broadcast, 'replay');
        if (r.status === 'duplicate') report.duplicates++;
        else report.applied++;
      } catch (err) {
        if (err instanceof ValidationError) report.invalid++;
        else throw err;
      }
    }
    fs.rmSync(file, { force: true });
  }
  return report;
}
