// Dump a task's recorded output_text. Read-only.
// Usage: node scripts/_dump-task-output.mjs <db-path> <task-id> [maxchars]
import Database from 'better-sqlite3';

const [, , dbPath, taskId, maxArg] = process.argv;
if (!dbPath || !taskId) {
  console.error('Usage: node scripts/_dump-task-output.mjs <db-path> <task-id> [maxchars]');
  process.exit(1);
}
const max = maxArg ? Number.parseInt(maxArg, 10) : 4000;

const db = new Database(dbPath, { readonly: true });
const row = db
  .prepare('SELECT id, name, status, output_json FROM tasks WHERE id = ?')
  .get(taskId);
db.close();

if (!row) {
  console.log(`(task ${taskId} not found)`);
  process.exit(0);
}
console.log(`# ${row.id}  [${row.status}]  ${row.name}`);
console.log('---');
let text = String(row.output_json ?? '(null)');
// output_json typically wraps the cli output in a JSON envelope. Try to
// unwrap to the raw text the reviewer would have seen.
try {
  const parsed = JSON.parse(text);
  if (typeof parsed === 'string') text = parsed;
  else if (typeof parsed?.output === 'string') text = parsed.output;
  else if (typeof parsed?.result === 'string') text = parsed.result;
} catch { /* keep raw */ }
console.log(text.length > max ? text.slice(0, max) + `\n...(truncated, ${text.length} chars total)` : text);
