// One-shot helper: confirms that seedE2EFixtures() created the expected rows.
// Used by Wave 3 M1-W3-C dry-run verification only.
import { initDb } from '../dist/db/client.js';
import { getDbPath } from '../dist/utils/config.js';

const db = initDb(getDbPath());
try {
  const workflows = db.prepare("SELECT id, status FROM workflows WHERE id LIKE 'wf_e2e_seed%'").all();
  const gates = db.prepare("SELECT id, status, workflow_id FROM hitl_gates WHERE id LIKE 'gate_e2e_seed%'").all();
  const patterns = db.prepare("SELECT id, name FROM patterns WHERE id LIKE 'pat_e2e_seed%'").all();
  const tasks = db.prepare("SELECT id, workflow_id, status FROM tasks WHERE workflow_id LIKE 'wf_e2e_seed%'").all();
  console.log('workflows:', JSON.stringify(workflows, null, 2));
  console.log('gates:', JSON.stringify(gates, null, 2));
  console.log('patterns:', JSON.stringify(patterns, null, 2));
  console.log('tasks:', JSON.stringify(tasks, null, 2));
} finally {
  db.close();
}
