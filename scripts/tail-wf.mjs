#!/usr/bin/env node
/**
 * Live tail of the latest executing workflow's events.
 *
 * Polls the events table every 2 seconds and prints new rows as they arrive.
 * Completely read-only — safe to run alongside an active workflow.
 *
 * Usage (terminal separate from the running workflow):
 *   cd "C:\Users\Example User\Desktop\omniforge"
 *   node scripts/tail-wf.mjs              # tail the most recent executing workflow
 *   node scripts/tail-wf.mjs <wf_id>      # tail a specific workflow
 *
 * Stops automatically when the workflow reaches status completed or failed.
 * Ctrl+C to exit earlier.
 */

process.env.DOTENV_CONFIG_QUIET = 'true';

const POLL_MS = 2000;

const { initDb } = await import('../dist/db/client.js');
const { getDbPath } = await import('../dist/utils/config.js');

const db = initDb(getDbPath());

let wfId = process.argv[2];
if (!wfId) {
  const row = db
    .prepare(
      "SELECT id FROM workflows WHERE status = 'executing' ORDER BY started_at DESC LIMIT 1",
    )
    .get();
  if (!row) {
    console.error('No executing workflow found. Pass a workflow_id or start one first.');
    process.exit(1);
  }
  wfId = row.id;
}

const wf = db
  .prepare('SELECT id, objective, status, started_at FROM workflows WHERE id = ?')
  .get(wfId);

if (!wf) {
  console.error(`Workflow not found: ${wfId}`);
  process.exit(1);
}

console.log('─'.repeat(70));
console.log(`Tailing: ${wf.id}`);
console.log(`Status:   ${wf.status}`);
console.log(`Objective:${wf.objective.slice(0, 100)}…`);
console.log('─'.repeat(70));

let lastSeenTs = 0;
const seenEventRowids = new Set();

function printEvent(row) {
  const ts = new Date(row.timestamp);
  const hms = ts.toISOString().slice(11, 19);
  const taskTag = row.task_id ? `[${row.task_id.slice(-8)}]` : '[workflow]';
  const payload = row.payload_json ? ` ${row.payload_json.slice(0, 80)}` : '';
  console.log(`${hms}  ${row.type.padEnd(30)} ${taskTag}${payload}`);
}

async function tick() {
  // Status check — stop when workflow closes
  const currentStatus = db
    .prepare('SELECT status FROM workflows WHERE id = ?')
    .get(wfId);
  if (
    currentStatus &&
    (currentStatus.status === 'completed' || currentStatus.status === 'failed')
  ) {
    const events = db
      .prepare(
        'SELECT rowid, type, task_id, timestamp, payload_json FROM events WHERE workflow_id = ? AND timestamp >= ? ORDER BY timestamp, rowid',
      )
      .all(wfId, lastSeenTs);
    for (const e of events) {
      if (!seenEventRowids.has(e.rowid)) {
        printEvent(e);
        seenEventRowids.add(e.rowid);
        lastSeenTs = Math.max(lastSeenTs, e.timestamp);
      }
    }
    console.log('─'.repeat(70));
    console.log(`Final status: ${currentStatus.status}`);
    console.log('─'.repeat(70));
    db.close();
    process.exit(0);
  }

  const newEvents = db
    .prepare(
      'SELECT rowid, type, task_id, timestamp, payload_json FROM events WHERE workflow_id = ? AND timestamp >= ? ORDER BY timestamp, rowid',
    )
    .all(wfId, lastSeenTs);

  for (const e of newEvents) {
    if (!seenEventRowids.has(e.rowid)) {
      printEvent(e);
      seenEventRowids.add(e.rowid);
      lastSeenTs = Math.max(lastSeenTs, e.timestamp);
    }
  }
}

// Print all historic events on first tick
const historic = db
  .prepare(
    'SELECT rowid, type, task_id, timestamp, payload_json FROM events WHERE workflow_id = ? ORDER BY timestamp, rowid',
  )
  .all(wfId);
for (const e of historic) {
  printEvent(e);
  seenEventRowids.add(e.rowid);
  lastSeenTs = Math.max(lastSeenTs, e.timestamp);
}

const interval = setInterval(() => {
  tick().catch((err) => {
    console.error('Tail error:', err.message);
    clearInterval(interval);
    db.close();
    process.exit(1);
  });
}, POLL_MS);

process.on('SIGINT', () => {
  clearInterval(interval);
  db.close();
  console.log('\n(tail stopped by user)');
  process.exit(0);
});
