import Database from 'better-sqlite3';
const db = new Database('data/omniforge.db');
const cmd = process.argv[2];

if (cmd === 'counts') {
  const wf = db.prepare('SELECT COUNT(*) as n FROM workflows').get().n;
  const tk = db.prepare('SELECT COUNT(*) as n FROM tasks').get().n;
  const ev = db.prepare('SELECT COUNT(*) as n FROM events').get().n;
  console.log(`wf:${wf} task:${tk} event:${ev}`);
}

if (cmd === 'schema-s3') {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_task_leases'").all();
  console.log('workflow_task_leases indexes:', indexes.map(r => r.name).join(', '));
  const tfSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='trigger_fires'").get();
  console.log('trigger_fires schema:', tfSchema ? 'EXISTS' : 'MISSING');
  if (tfSchema) console.log(tfSchema.sql.substring(0, 300));
  const tfIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='trigger_fires'").all();
  console.log('trigger_fires indexes:', tfIndexes.map(r => r.name).join(', '));
}

if (cmd === 's8-events') {
  const rows = db.prepare("SELECT DISTINCT type FROM events WHERE type LIKE '%_parse_failed%' OR type LIKE '%_extract_failed%' ORDER BY type").all();
  console.log('Instrumented error events found:', rows.length);
  rows.forEach(r => console.log(' ', r.type));
}

if (cmd === 's9-gate') {
  const gateId = process.argv[3];
  const row = db.prepare('SELECT status, context_json FROM hitl_gates WHERE id=?').get(gateId);
  if (row) console.log(`Gate status: ${row.status}, context: ${row.context_json}`);
  else console.log('Gate not found');
  const ev = db.prepare("SELECT type, payload_json FROM events WHERE type='hitl_gate_orphan_recovered' ORDER BY id DESC LIMIT 1").get();
  if (ev) console.log(`Recovery event: ${ev.type} | ${ev.payload_json?.substring(0, 200)}`);
  else console.log('No hitl_gate_orphan_recovered event found');
}

if (cmd === 's10-fire') {
  const fireId = process.argv[3];
  const row = db.prepare('SELECT dispatched_at, workflow_id FROM trigger_fires WHERE id=?').get(fireId);
  if (row) console.log(`dispatched_at: ${row.dispatched_at}, workflow_id: ${row.workflow_id}`);
  else console.log('Fire not found');
}

if (cmd === 'schedules') {
  const rows = db.prepare('SELECT id, name FROM dashboard_schedules LIMIT 3').all();
  console.log('Schedules:', rows.length);
  rows.forEach(r => console.log(' ', r.id, r.name));
}

if (cmd === 'last-wf') {
  const row = db.prepare('SELECT id, status FROM workflows ORDER BY rowid DESC LIMIT 1').get();
  if (row) console.log(`${row.id} | ${row.status}`);
  else console.log('No workflows');
}

if (cmd === 'wf-tasks') {
  const wfId = process.argv[3];
  const rows = db.prepare('SELECT id, status FROM tasks WHERE workflow_id=?').all(wfId);
  console.log(`Tasks for ${wfId}: ${rows.length}`);
  rows.forEach(r => console.log(` ${r.id} | ${r.status}`));
}

if (cmd === 'wf-events') {
  const wfId = process.argv[3];
  const rows = db.prepare("SELECT DISTINCT type FROM events WHERE workflow_id=? AND type IN ('task_aborted','workflow_canceled')").all(wfId);
  console.log('Cancel event types found:', rows.map(r => r.type).join(', ') || 'NONE');
}

if (cmd === 'cascade-before') {
  const wfId = process.argv[3];
  const tk = db.prepare('SELECT COUNT(*) as n FROM tasks WHERE workflow_id=?').get(wfId).n;
  const ev = db.prepare('SELECT COUNT(*) as n FROM events WHERE workflow_id=?').get(wfId).n;
  console.log(`tasks:${tk} events:${ev}`);
}

if (cmd === 'cascade-delete') {
  db.pragma('foreign_keys = ON');
  const wfId = process.argv[3];
  try {
    db.prepare('DELETE FROM workflows WHERE id=?').run(wfId);
    const tk = db.prepare('SELECT COUNT(*) as n FROM tasks WHERE workflow_id=?').get(wfId).n;
    const ev = db.prepare('SELECT COUNT(*) as n FROM events WHERE workflow_id=?').get(wfId).n;
    console.log(`DELETE OK. After: tasks:${tk} events:${ev}`);
  } catch (e) {
    console.log('DELETE FAILED:', e.message);
  }
}

if (cmd === 'running-wf') {
  const rows = db.prepare("SELECT id, status FROM workflows WHERE status='running' ORDER BY rowid DESC LIMIT 3").all();
  console.log('Running workflows:', rows.length);
  rows.forEach(r => console.log(` ${r.id} | ${r.status}`));
}

if (cmd === 'wf-status') {
  const wfId = process.argv[3];
  const row = db.prepare('SELECT id, status FROM workflows WHERE id=?').get(wfId);
  if (row) console.log(`${row.id}: ${row.status}`);
  else console.log('Workflow not found');
}

if (cmd === 'redact-check') {
  const wfId = process.argv[3];
  const chunks = db.prepare("SELECT payload_json FROM events WHERE workflow_id=? AND type='task_streaming_chunk' LIMIT 5").all(wfId);
  console.log('Streaming chunks:', chunks.length);
  let rawCount = 0;
  chunks.forEach(c => {
    if (c.payload_json && c.payload_json.includes('sk-proj')) rawCount++;
    console.log(' chunk:', (c.payload_json || '').substring(0, 100));
  });
  const rawTotal = db.prepare("SELECT COUNT(*) as n FROM events WHERE workflow_id=? AND instr(payload_json,'sk-proj')>0").get(wfId).n;
  console.log(`Raw secret appearances in events: ${rawTotal}`);
}

if (cmd === 'insert-gate') {
  db.pragma('foreign_keys = ON');
  const gateId = process.argv[3];
  const wfId = db.prepare('SELECT id FROM workflows LIMIT 1').get()?.id;
  const oldMs = Date.now() - 10 * 60 * 1000;
  try {
    db.prepare("INSERT INTO hitl_gates (id, workflow_id, gate_type, prompt, context_json, status, channel, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
      gateId, wfId, 'review', 'smoke test orphan gate', '{}', 'pending', 'cli', oldMs
    );
    console.log(`Inserted gate ${gateId} for workflow ${wfId}`);
  } catch(e) { console.log('Insert failed:', e.message); }
}

db.close();
