import Database from 'better-sqlite3';
const db = new Database('data/omniforge.db');
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

const wfId = `wf_smoketest_${Date.now()}`;
const now = Date.now();

// Insert test workflow
db.prepare(`INSERT INTO workflows (id, workspace, objective, status, created_at)
  VALUES (?, 'internal', 'smoke test cascade', 'completed', ?)`).run(wfId, now);
console.log(`Inserted workflow: ${wfId}`);

// Insert 3 tasks
for (let i = 1; i <= 3; i++) {
  const taskId = `task_smoke_${i}_${Date.now()}`;
  db.prepare(`INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
    VALUES (?, ?, ?, 'llm_call', 'completed', ?)`).run(taskId, wfId, `smoke task ${i}`, now);
}
// Insert 5 events
for (let i = 1; i <= 5; i++) {
  db.prepare(`INSERT INTO events (workflow_id, type, payload_json, timestamp)
    VALUES (?, 'smoke_test_event', '{}', ?)`).run(wfId, now);
}

const tasksBefore = db.prepare('SELECT COUNT(*) as n FROM tasks WHERE workflow_id=?').get(wfId).n;
const eventsBefore = db.prepare('SELECT COUNT(*) as n FROM events WHERE workflow_id=?').get(wfId).n;
console.log(`Before DELETE: tasks=${tasksBefore} events=${eventsBefore}`);

// DELETE — should CASCADE
try {
  db.prepare('DELETE FROM workflows WHERE id=?').run(wfId);
  const tasksAfter = db.prepare('SELECT COUNT(*) as n FROM tasks WHERE workflow_id=?').get(wfId).n;
  const eventsAfter = db.prepare('SELECT COUNT(*) as n FROM events WHERE workflow_id=?').get(wfId).n;
  console.log(`DELETE OK. After: tasks=${tasksAfter} events=${eventsAfter}`);
  if (tasksAfter === 0 && eventsAfter === 0) {
    console.log('RESULT: PASS — FK CASCADE working');
  } else {
    console.log('RESULT: FAIL — child rows survived DELETE');
  }
} catch (e) {
  console.log(`RESULT: FAIL — DELETE threw: ${e.message}`);
}

db.close();
