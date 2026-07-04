/**
 * S10 smoke — trigger orphan retry sweep.
 * Inserts an undispatched trigger_fires row (past grace window), restarts
 * daemon, verifies the runTriggerOrphanRetrySweep picks it up and dispatches.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

const FIRE_ID = process.argv[2];
if (!FIRE_ID) { console.error('Usage: node _smoke_s10_trigger.mjs <fire_id> [check]'); process.exit(1); }

const db = new Database('data/omniforge.db');
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

const schedId = db.prepare('SELECT id FROM dashboard_schedules LIMIT 1').get()?.id;
const wsName = db.prepare('SELECT name FROM dashboard_workspaces LIMIT 1').get()?.name;

if (!schedId) { console.log('No schedule — S10 N/A'); db.close(); process.exit(0); }

const cmd = process.argv[3];

if (cmd === 'check') {
  const row = db.prepare('SELECT dispatched_at, workflow_id FROM trigger_fires WHERE id=?').get(FIRE_ID);
  if (!row) { console.log('Fire not found'); }
  else {
    console.log(`dispatched_at: ${row.dispatched_at ?? 'NULL'}`);
    console.log(`workflow_id:   ${row.workflow_id ?? 'NULL'}`);
    const dispatched = row.dispatched_at != null;
    console.log(`\nRESULT: ${dispatched ? 'PASS' : 'FAIL'}`);
    if (!dispatched) console.log('  FAIL: trigger_fire still undispatched after daemon restart');
  }
  db.close();
  process.exit(0);
}

// Insert undispatched fire
const OLD_MS = Date.now() - 10 * 60 * 1000; // 10 minutes ago
try {
  db.prepare(`
    INSERT INTO trigger_fires (id, trigger_source, schedule_id, webhook_id, workspace,
      target_kind, target_ref, input_payload_json, live_payload, fired_at, attempt, created_at)
    VALUES (?, 'schedule', ?, NULL, ?, 'objective', 'smoke test s10 objective', '{}', '{}', ?, 1, ?)
  `).run(FIRE_ID, schedId, wsName, OLD_MS, OLD_MS);
  console.log(`Inserted trigger_fire: ${FIRE_ID}`);
  console.log(`  schedule_id: ${schedId}`);
  console.log(`  workspace:   ${wsName}`);
  console.log(`  fired_at:    ${new Date(OLD_MS).toISOString()} (10min ago)`);
  console.log(`  dispatched_at: NULL (orphan)`);
} catch(e) {
  console.log('Insert failed:', e.message);
}

db.close();
