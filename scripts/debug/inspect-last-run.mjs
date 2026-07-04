// Inspects the latest workflow: task names, executor_hint, status, output length,
// and a summary of review events. Helps diagnose why a run used unexpected models.

import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const DB_PATH = resolve('data', 'omniforge.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const wf = db.prepare(
  `SELECT id, objective, status, metadata, created_at FROM workflows ORDER BY created_at DESC LIMIT 1`,
).get();

if (!wf) {
  console.error('No workflow found.');
  process.exit(1);
}

console.log(`Workflow: ${wf.id}`);
console.log(`Status:   ${wf.status}`);
console.log(`Objective (trunc): ${wf.objective.slice(0, 100)}...`);
console.log('');

const tasks = db.prepare(
  `SELECT name, executor_hint, kind, status, refine_count,
          length(output_json) AS out_len, acceptance_criteria IS NOT NULL AS has_criteria
     FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC`,
).all(wf.id);

console.log(`--- Tasks (${tasks.length}) ---`);
for (const t of tasks) {
  const hint = t.executor_hint ?? '(none → TASK_MODEL)';
  console.log(
    `  ${t.status.padEnd(10)} ${t.kind.padEnd(12)} hint=${String(hint).padEnd(40)} ` +
    `crit=${t.has_criteria ? 'Y' : 'N'} refine=${t.refine_count} out=${t.out_len ?? 0}b`,
  );
  console.log(`    ${t.name}`);
}

console.log('');
console.log('--- Reviewer model actually used ---');
const reviews = db.prepare(
  `SELECT reviewer_model, COUNT(*) as n FROM reviews WHERE workflow_id = ? GROUP BY reviewer_model`,
).all(wf.id);
if (reviews.length === 0) {
  console.log('  (no reviews persisted — every review errored before scoring)');
} else {
  reviews.forEach((r) => console.log(`  ${r.reviewer_model}: ${r.n}`));
}

console.log('');
console.log('--- Event summary ---');
const evts = db.prepare(
  `SELECT type, COUNT(*) as n FROM events WHERE workflow_id = ? GROUP BY type ORDER BY n DESC`,
).all(wf.id);
for (const e of evts) console.log(`  ${e.type.padEnd(35)} ${e.n}`);

if (wf.metadata) {
  try {
    const meta = JSON.parse(wf.metadata);
    if (meta.consolidated_output) {
      console.log('');
      console.log(`--- Consolidated output: ${meta.consolidated_output.length} bytes ---`);
      console.log(`    preview: ${meta.consolidated_output.slice(0, 120).replace(/\s+/g, ' ')}...`);
    }
  } catch {}
}
