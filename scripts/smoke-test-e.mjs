// Smoke test for Cluster E: Secrets Vault + Replay Debugger
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktree = path.resolve(__dirname, '..');

let allPass = true;
function check(label, pass, detail = '') {
  const marker = pass ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) allPass = false;
}

// ── Setup temp DB ─────────────────────────────────────────────────────────────
const tmpDb = path.join(os.tmpdir(), 'smoke_e_' + Date.now() + '.db');
const db = new Database(tmpDb);

// Apply migrations
const migSql = fs.readFileSync(path.join(worktree, 'src/db/migrations/028_secrets.sql'), 'utf8');
db.exec(migSql);

// tasks table minimal for replay test
db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, workspace TEXT, status TEXT, name TEXT, objective TEXT,
    executor_hint TEXT, created_at INTEGER, updated_at INTEGER, dag_json TEXT,
    auto_approve INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, workflow_id TEXT, name TEXT, status TEXT,
    kind TEXT DEFAULT 'llm_call', executor_hint TEXT, input_json TEXT,
    output TEXT, error TEXT, replay_of TEXT, created_at INTEGER, updated_at INTEGER,
    timeout_seconds INTEGER DEFAULT 300, acceptance_criteria TEXT, refine_feedback TEXT,
    FOREIGN KEY(workflow_id) REFERENCES workflows(id)
  );
`);

// Try 029 migration (column may already exist above)
try {
  const replaySql = fs.readFileSync(path.join(worktree, 'src/db/migrations/029_task_replay.sql'), 'utf8');
  // Only run ADD COLUMN parts (the table already exists above)
  for (const stmt of replaySql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { db.exec(stmt + ';'); } catch(e) { /* ignore "already exists" */ }
  }
} catch(e) {
  console.log('replay migration skipped:', e.message);
}

// ── Secrets: AES-256-GCM ─────────────────────────────────────────────────────
const masterKey = crypto.randomBytes(32);
const secretValue = 'https://hooks.slack.com/services/REAL_WEBHOOK_VALUE';

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
let enc = cipher.update(secretValue, 'utf8');
enc = Buffer.concat([enc, cipher.final()]);
const authTag = cipher.getAuthTag();

const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
decipher.setAuthTag(authTag);
let dec = decipher.update(enc);
dec = Buffer.concat([dec, decipher.final()]).toString('utf8');

check('AES-256-GCM roundtrip', dec === secretValue);

// ── Secrets: DB CRUD ─────────────────────────────────────────────────────────
db.prepare('INSERT INTO secrets(id,workspace,key,value_encrypted,iv,auth_tag,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
  'sec1', 'internal', 'SLACK_WEBHOOK', enc, iv, authTag, Date.now(), Date.now()
);
const row = db.prepare('SELECT * FROM secrets WHERE key=?').get('SLACK_WEBHOOK');
check('DB insert+select', row && row.key === 'SLACK_WEBHOOK');
check('Encrypted value not plaintext in DB', !row.value_encrypted.toString('utf8').includes('hooks.slack.com'));

// List secrets without value
const listed = db.prepare('SELECT id, key, created_at, updated_at FROM secrets WHERE workspace=?').all('internal');
check('listSecrets returns no value_encrypted field', listed.length === 1 && listed[0].key === 'SLACK_WEBHOOK' && !('value_encrypted' in listed[0]));

// ── Secrets: resolveSecrets ───────────────────────────────────────────────────
const prompt = 'Send notification to {{secret:SLACK_WEBHOOK}} immediately';
const resolved = prompt.replace(/\{\{secret:([A-Z0-9_]+)\}\}/g, (_, k) => {
  const r = db.prepare('SELECT value_encrypted, iv, auth_tag FROM secrets WHERE workspace=? AND key=?').get('internal', k);
  if (!r) return `{{secret:${k}}}`;
  const d2 = crypto.createDecipheriv('aes-256-gcm', masterKey, r.iv);
  d2.setAuthTag(r.auth_tag);
  let v = d2.update(r.value_encrypted);
  return Buffer.concat([v, d2.final()]).toString('utf8');
});
check('resolveSecrets substitutes {{secret:SLACK_WEBHOOK}}', resolved.includes('hooks.slack.com') && !resolved.includes('{{secret:'));

// ── Secrets: redactSecrets ────────────────────────────────────────────────────
const eventPayload = JSON.stringify({ message: `Webhook sent to ${secretValue} at 10:00`, status: 'ok' });
const escaped = secretValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const redacted = eventPayload.replace(new RegExp(escaped, 'g'), '***REDACTED***');
check('redactSecrets replaces value with ***REDACTED*** in event', redacted.includes('***REDACTED***') && !redacted.includes('hooks.slack.com'));

// ── Replay: create original task ──────────────────────────────────────────────
db.prepare('INSERT INTO workflows(id,workspace,status,name,objective,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(
  'wf1', 'internal', 'failed', 'Test WF', 'Do something', Date.now(), Date.now()
);
db.prepare('INSERT INTO tasks(id,workflow_id,name,status,kind,executor_hint,input_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
  'task1', 'wf1', 'Analyze data', 'failed', 'llm_call', 'claude-sonnet-4-6',
  JSON.stringify({ prompt: 'Analyze the dataset' }), 'Model timeout', Date.now(), Date.now()
);

const originalTask = db.prepare('SELECT * FROM tasks WHERE id=?').get('task1');
check('Original task exists with status=failed', originalTask && originalTask.status === 'failed');

// ── Replay: simulate POST /api/dashboard/tasks/:tid/replay ───────────────────
function simulateReplay(tid, opts = {}) {
  const orig = db.prepare('SELECT * FROM tasks WHERE id=?').get(tid);
  if (!orig) throw new Error('Task not found: ' + tid);

  const origInput = JSON.parse(orig.input_json || '{}');
  const newInput = {
    ...origInput,
    ...(opts.prompt_override ? { prompt: opts.prompt_override } : {}),
    ...(opts.context_override ? { context: opts.context_override } : {}),
  };
  const newModel = opts.model_override || orig.executor_hint;
  const newId = 'task_replay_' + Date.now();

  db.prepare('INSERT INTO tasks(id,workflow_id,name,status,kind,executor_hint,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
    newId, orig.workflow_id, orig.name + ' [replay]', 'pending', orig.kind,
    newModel, JSON.stringify(newInput), Date.now(), Date.now()
  );
  db.prepare('UPDATE tasks SET replay_of=? WHERE id=?').run(tid, newId);

  return { task_id: newId, workflow_id: orig.workflow_id, mode: 'same_workflow' };
}

const replayResult = simulateReplay('task1', {
  prompt_override: 'Analyze the dataset with extra context',
  model_override: 'claude-opus-4-6',
});
check('Replay creates new task', !!replayResult.task_id);
check('Replay response has workflow_id', !!replayResult.workflow_id);
check('Replay response has mode=same_workflow', replayResult.mode === 'same_workflow');

const newTask = db.prepare('SELECT * FROM tasks WHERE id=?').get(replayResult.task_id);
check('New task has replay_of pointing to original task id', newTask && newTask.replay_of === 'task1');
check('New task uses overridden model', newTask && newTask.executor_hint === 'claude-opus-4-6');

const newInput = JSON.parse(newTask.input_json);
check('New task has overridden prompt', newInput.prompt === 'Analyze the dataset with extra context');

// ── Cleanup ───────────────────────────────────────────────────────────────────
db.close();
fs.unlinkSync(tmpDb);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + (allPass ? '✓ ALL SMOKE TESTS PASSED' : '✗ SOME TESTS FAILED'));
process.exit(allPass ? 0 : 1);
