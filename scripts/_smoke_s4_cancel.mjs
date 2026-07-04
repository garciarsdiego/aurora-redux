/**
 * S4 smoke test — cancel propagation.
 * Seeds a workflow + tasks in active states, calls the HTTP cancel endpoint,
 * verifies all tasks end up 'cancelled' (not 'failed') and workflow_canceled event fires.
 */
import Database from 'better-sqlite3';

const TOKEN = (await import('fs')).readFileSync('data/daemon-token.txt', 'utf8').trim();
const BASE = 'http://127.0.0.1:20129';

const db = new Database('data/omniforge.db');
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

const now = Date.now();
const wfId = `wf_s4_cancel_${now}`;

// Seed: 1 executing workflow, 2 running tasks + 1 pending task
db.prepare(`INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
  VALUES (?, 'internal', 's4 cancel smoke test', 'executing', ?, ?)`).run(wfId, now, now);

const tasks = [
  { id: `tk_s4_run1_${now}`, status: 'running' },
  { id: `tk_s4_run2_${now}`, status: 'running' },
  { id: `tk_s4_pend_${now}`, status: 'pending' },
];
for (const t of tasks) {
  db.prepare(`INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
    VALUES (?, ?, ?, 'llm_call', ?, ?)`).run(t.id, wfId, `${t.status} task`, t.status, now);
}
db.close();

console.log(`Seeded: wf=${wfId}, tasks=${tasks.map(t=>t.id.slice(-8)).join(',')}`);

// Call cancel endpoint
const resp = await fetch(`${BASE}/api/dashboard/workflows/${wfId}/control`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'cancel', reason: 's4_smoke_test', requested_by: 'validator' }),
});
const body = await resp.json();
console.log(`Cancel HTTP: ${resp.status}`);
console.log('Response:', JSON.stringify(body, null, 2).substring(0, 300));

// Verify DB state
await new Promise(r => setTimeout(r, 500));
const db2 = new Database('data/omniforge.db');
const wfRow = db2.prepare('SELECT id, status FROM workflows WHERE id=?').get(wfId);
console.log(`\nWorkflow status: ${wfRow?.status}  (expect: cancelled)`);

const taskRows = db2.prepare('SELECT id, status FROM tasks WHERE workflow_id=?').all(wfId);
console.log('Task statuses:');
taskRows.forEach(r => console.log(`  ${r.id.slice(-12)}: ${r.status}  (expect: cancelled)`));

const events = db2.prepare("SELECT type FROM events WHERE workflow_id=? AND type IN ('workflow_canceled','task_cancelled_by_workflow') ORDER BY id").all(wfId);
console.log('\nCancel events:', events.map(e => e.type).join(', ') || 'NONE');

const allCancelled = wfRow?.status === 'cancelled' && taskRows.every(r => r.status === 'cancelled');
const hasEvents = events.some(e => e.type === 'workflow_canceled');
console.log(`\nRESULT: ${allCancelled && hasEvents ? 'PASS' : 'FAIL'}`);
if (!allCancelled) console.log('  FAIL reason: not all rows are cancelled');
if (!hasEvents) console.log('  FAIL reason: workflow_canceled event missing');

db2.close();
