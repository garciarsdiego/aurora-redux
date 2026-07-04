import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../src/db/persist.js';
import { buildFinalProductEvidenceBundle } from '../src/quality/final-evidence.js';
import { enforceFinalQualityReview, FinalQualityGateFailedError } from '../src/quality/final-reviewer.js';
import type { Task, Workflow } from '../src/types/index.js';

function makeWorkflow(objective: string): Workflow {
  const now = Date.now();
  return {
    id: newWorkflowId(),
    workspace: 'internal',
    objective,
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: 'quality-smoke',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(workflowId: string, root: string, name: string): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name,
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: { worktree_root: root } }),
    output_json: `${name} delivered files under ${root}.`,
    status: 'completed',
    depends_on: [],
    executor_hint: 'cli:codex',
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: now,
    completed_at: now,
    created_at: now,
    acceptance_criteria: 'The delivered web app behavior must match the visible UI instructions.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function writeGoodMiniApp(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'App.tsx'),
    [
      'export function App() {',
      '  return <main><h1>Mini blocks</h1><p>Press Enter to start. Move with ArrowLeft and ArrowRight.</p></main>;',
      '}',
      'window.addEventListener("keydown", (event) => {',
      '  if (event.key === "Enter") console.log("start");',
      '  if (event.key === "ArrowLeft") console.log("left");',
      '  if (event.key === "ArrowRight") console.log("right");',
      '});',
    ].join('\n'),
  );
}

function writeBadMiniApp(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'App.tsx'),
    [
      'export function App() {',
      '  return <main><h1>Mini blocks</h1><p>Press Enter to start. Move with A/D. Hold with C.</p></main>;',
      '}',
      'window.addEventListener("keydown", (event) => {',
      '  if (event.key === "ArrowLeft") console.log("left");',
      '  if (event.key === "ArrowRight") console.log("right");',
      '});',
    ].join('\n'),
  );
}

const db = initDb(':memory:');
const goodRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-good-'));
const badRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-bad-'));

try {
  writeGoodMiniApp(goodRoot);
  const goodWorkflow = makeWorkflow('Build a small playable web app with accurate controls');
  insertWorkflow(db, goodWorkflow);
  insertTask(db, makeTask(goodWorkflow.id, goodRoot, 'Build good mini app'));
  const goodBundle = buildFinalProductEvidenceBundle(db, goodWorkflow.id);
  assert.equal(goodBundle.productHarness.status, 'passed');

  writeBadMiniApp(badRoot);
  const badWorkflow = makeWorkflow('Build a small playable web app with mismatched controls');
  insertWorkflow(db, badWorkflow);
  insertTask(db, makeTask(badWorkflow.id, badRoot, 'Build bad mini app'));

  let blocked = false;
  try {
    await enforceFinalQualityReview(db, {
      workflowId: badWorkflow.id,
      mode: 'enforced',
    });
  } catch (err) {
    if (err instanceof FinalQualityGateFailedError) blocked = true;
    else throw err;
  }

  assert.equal(blocked, true);
  const fixRows = db
    .prepare(`SELECT id FROM tasks WHERE workflow_id = ? AND status = 'pending'`)
    .all(badWorkflow.id);
  assert.ok(fixRows.length > 0, 'expected final quality gate to create fix tasks');

  console.log(JSON.stringify({
    ok: true,
    good_workflow_id: goodWorkflow.id,
    good_harness_status: goodBundle.productHarness.status,
    bad_workflow_id: badWorkflow.id,
    bad_blocked: blocked,
    generated_fix_tasks: fixRows.length,
  }, null, 2));
} finally {
  db.close();
  rmSync(goodRoot, { recursive: true, force: true });
  rmSync(badRoot, { recursive: true, force: true });
}
