// Extracts consolidated_output from the latest (or specified) workflow to a file.
//
// Usage:
//   node scripts/extract-output.mjs                                # latest → out.html
//   node scripts/extract-output.mjs <wf_id>                         # specific → out.html
//   node scripts/extract-output.mjs <wf_id> <outpath>              # specific → given path
//   node scripts/extract-output.mjs --tasks                         # latest → dump each task output too

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DB_PATH = resolve('data', 'omniforge.db');
const args = process.argv.slice(2);
const dumpTasks = args.includes('--tasks');
const positional = args.filter((a) => !a.startsWith('--'));

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

function latestWorkflowId() {
  const row = db.prepare(
    `SELECT id FROM workflows ORDER BY created_at DESC LIMIT 1`,
  ).get();
  return row?.id ?? null;
}

const wfId = positional[0] ?? latestWorkflowId();
const outPath = positional[1] ?? resolve('out', 'consolidated.html');

if (!wfId) {
  console.error('No workflow found.');
  process.exit(1);
}

const wf = db.prepare(`SELECT id, status, metadata, objective FROM workflows WHERE id = ?`).get(wfId);
if (!wf) {
  console.error(`Workflow ${wfId} not found.`);
  process.exit(1);
}

console.log(`Workflow: ${wf.id}`);
console.log(`Status:   ${wf.status}`);
console.log(`Objective: ${wf.objective.slice(0, 80)}${wf.objective.length > 80 ? '...' : ''}`);
console.log('');

if (wf.metadata) {
  const meta = JSON.parse(wf.metadata);
  if (meta.consolidated_output) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, meta.consolidated_output, 'utf8');
    console.log(`✓ Consolidated output → ${outPath} (${meta.consolidated_output.length} bytes)`);
  } else {
    console.log('⚠ Metadata present but no consolidated_output field.');
  }
} else {
  console.log('⚠ No metadata on workflow — consolidation may not have run yet.');
}

if (dumpTasks) {
  const tasks = db.prepare(
    `SELECT name, output_json, status FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC`,
  ).all(wfId);

  const tasksDir = resolve('out', 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  console.log('');
  console.log(`Writing ${tasks.length} task outputs to ${tasksDir}/`);
  tasks.forEach((t, i) => {
    const safe = t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    const fname = `${String(i + 1).padStart(2, '0')}-${safe}.txt`;
    writeFileSync(resolve(tasksDir, fname), t.output_json ?? '(empty)', 'utf8');
    console.log(`  ${fname} (${t.status}, ${t.output_json?.length ?? 0} bytes)`);
  });
}
