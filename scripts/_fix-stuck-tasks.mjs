import { initDb } from '../dist/db/client.js';

const db = initDb('data/omniforge.db');

const ids = [
  'tk_88264a53-fc8a-498d-8776-644999015ebb',
  'tk_89cc8c00-dd5e-4025-afb7-769e5554bc87',
  'tk_0a5acbbc-283b-425d-a8d3-7d7910b7f240',
  'tk_0347419e-aa75-4043-ac9a-93b6dd127a1d',
  'tk_534fddd9-4557-442d-a5e3-c2346e7e130d',
  'tk_7ca8471a-0ec3-4b97-afe0-0434e2f482a8',
];

const stmt = db.prepare("UPDATE tasks SET status='failed', refine_feedback='dep_failed_skipped' WHERE id=?");
for (const id of ids) {
  const result = stmt.run(id);
  console.log(result.changes ? `✓ failed: ${id}` : `? not found: ${id}`);
}

db.close();
console.log('Pronto. Agora rode: node scripts/resume-wf.mjs wf_9dc5d041-f202-4f75-8925-fda989268307');
