// Live tail of workflow events. Polls the DB every 1.5s, prints new rows.
// Run in a separate terminal while `omniforge run` is executing.
//
// Usage:
//   node scripts/tail-events.mjs                # tail latest workflow
//   node scripts/tail-events.mjs <workflow_id>  # specific workflow

import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const DB_PATH = resolve('data', 'omniforge.db');
const POLL_MS = 1500;
const argWfId = process.argv[2];

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

function latestWorkflowId() {
  const row = db.prepare(
    `SELECT id FROM workflows ORDER BY created_at DESC LIMIT 1`,
  ).get();
  return row?.id ?? null;
}

const wfId = argWfId ?? latestWorkflowId();
if (!wfId) {
  console.error('No workflow found.');
  process.exit(1);
}

console.log(`Tailing workflow: ${wfId}`);
console.log('-'.repeat(78));

// Task id → name lookup
const tasks = db.prepare(
  `SELECT id, name, status FROM tasks WHERE workflow_id = ?`,
).all(wfId);
const taskName = new Map(tasks.map((t) => [t.id, t.name]));
console.log(`${tasks.length} tasks in workflow`);
console.log('');

let lastEventId = 0;

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

function printEvents() {
  const rows = db.prepare(
    `SELECT id, timestamp, type, task_id, payload_json
       FROM events
      WHERE workflow_id = ? AND id > ?
      ORDER BY id ASC`,
  ).all(wfId, lastEventId);

  for (const ev of rows) {
    lastEventId = ev.id;
    const when = fmtTime(ev.timestamp);
    const label = ev.task_id ? `[${taskName.get(ev.task_id) ?? ev.task_id.slice(0, 8)}]` : '[workflow]';
    let extra = '';
    if (ev.payload_json) {
      try {
        const p = JSON.parse(ev.payload_json);
        const parts = [];
        if (typeof p.score === 'number') parts.push(`score=${p.score.toFixed(2)}`);
        if (typeof p.refine_count === 'number') parts.push(`refine=${p.refine_count}`);
        if (typeof p.output_length === 'number') parts.push(`len=${p.output_length}`);
        if (typeof p.elapsed_ms === 'number') parts.push(`elapsed=${p.elapsed_ms}ms`);
        if (p.error) parts.push(`err="${String(p.error).slice(0, 80)}"`);
        if (parts.length) extra = `  ${parts.join(' ')}`;
      } catch {
        // ignore
      }
    }
    console.log(`${when}  ${ev.type.padEnd(32)} ${label}${extra}`);
  }

  const wf = db.prepare(`SELECT status FROM workflows WHERE id = ?`).get(wfId);
  if (wf && (wf.status === 'completed' || wf.status === 'failed')) {
    console.log('');
    console.log(`--- workflow ${wf.status} ---`);
    process.exit(0);
  }
}

printEvents();
setInterval(printEvents, POLL_MS);
