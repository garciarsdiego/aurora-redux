// Quick read-only lookup of the most recent workflow in a given DB.
// Usage: node scripts/_lookup-last-wf.mjs <abs-path-to-db> [workspace]
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const workspace = process.argv[3] ?? 'internal';
if (!dbPath) {
  console.error('Usage: node scripts/_lookup-last-wf.mjs <db-path> [workspace]');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const wf = db
  .prepare(
    'SELECT id, status, created_at FROM workflows WHERE workspace = ? ORDER BY created_at DESC LIMIT 1',
  )
  .get(workspace);
if (!wf) {
  console.log('(no workflows)');
  process.exit(0);
}
console.log(JSON.stringify(wf, null, 2));

const tasks = db
  .prepare(
    'SELECT id, name, kind, status FROM tasks WHERE workflow_id = ? ORDER BY id',
  )
  .all(wf.id);
console.log('--- tasks ---');
for (const t of tasks) {
  console.log(`  ${t.id.padEnd(40)}  ${String(t.status).padEnd(11)} ${t.kind.padEnd(10)} ${t.name}`);
}
db.close();
