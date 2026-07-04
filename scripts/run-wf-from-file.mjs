#!/usr/bin/env node
/**
 * Run a new Omniforge workflow from a file-backed objective.
 *
 * Why a file instead of a CLI arg: objectives often contain Windows paths,
 * quotes, backticks, and multi-paragraph content. Shell escaping in cmd.exe /
 * PowerShell eats them. Reading from disk sidesteps the whole problem.
 *
 * Usage (from a terminal OUTSIDE Claude Code, so the workflow survives any
 * Claude Code crash):
 *   cd "C:\Users\Example User\Desktop\omniforge"
 *   node scripts/run-wf-from-file.mjs <workspace> <objective-file> [--auto-approve]
 *
 * Example:
 *   node scripts/run-wf-from-file.mjs internal scripts/d35-linkedin.txt --auto-approve
 *
 * The script runs synchronously until the workflow completes. The caller can
 * follow along in the terminal; the workflow is completely independent of any
 * Claude Code MCP server.
 */

process.env.DOTENV_CONFIG_QUIET = 'true';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/run-wf-from-file.mjs <workspace> <objective-file> [--auto-approve] [--no-pattern]');
  process.exit(1);
}

const [workspace, objectiveFile, ...flags] = args;
const autoApprove = flags.includes('--auto-approve');
const noPattern = flags.includes('--no-pattern');

const objectivePath = resolve(objectiveFile);
let objective;
try {
  objective = readFileSync(objectivePath, 'utf8').trim();
} catch (err) {
  console.error(`Cannot read objective file '${objectivePath}':`, err.message);
  process.exit(2);
}
if (!objective) {
  console.error(`Objective file '${objectivePath}' is empty`);
  process.exit(3);
}

const { initDb } = await import('../dist/db/client.js');
const { getDbPath } = await import('../dist/utils/config.js');
const { loadWorkspaceEnv } = await import('../dist/utils/workspace.js');
const { decompose } = await import('../dist/brain/decomposer.js');
const { executeWorkflow } = await import('../dist/brain/executor.js');
const { matchPattern } = await import('../dist/brain/patternMatcher.js');
const { listPatterns, bumpPatternUsage } = await import('../dist/patterns/store.js');
const { findExecutingWorkflow } = await import('../dist/db/persist.js');
const { makeProgressPrinter } = await import('../dist/cli/progress-printer.js');

loadWorkspaceEnv(workspace);
const db = initDb(getDbPath());

try {
  const existing = findExecutingWorkflow(db, workspace, objective);
  if (existing) {
    console.log(`Workflow já em execução com esse objetivo: ${existing.id}`);
    console.log(`Use: node scripts/resume-wf.mjs ${existing.id}`);
    process.exit(0);
  }

  let dag;
  let patternId;
  if (noPattern) {
    console.log('Gerando DAG novo via decomposer (--no-pattern)...');
    dag = await decompose(objective);
  } else {
    const patterns = listPatterns(db, workspace);
    const match = await matchPattern(objective, patterns);
    if (match.action === 'use') {
      console.log(`Usando pattern: ${match.pattern.name}`);
      dag = JSON.parse(match.pattern.dag_json);
      patternId = match.pattern.id;
    } else {
      console.log('Gerando DAG novo via decomposer...');
      dag = await decompose(objective);
    }
  }

  console.log('─'.repeat(70));
  console.log(`Workspace: ${workspace}`);
  console.log(`Tasks:     ${dag.tasks.length}`);
  console.log(`Auto-approve: ${autoApprove}`);
  console.log(`Objective: ${objective.slice(0, 120)}${objective.length > 120 ? '…' : ''}`);
  console.log('─'.repeat(70));
  for (const t of dag.tasks) {
    const deps = t.depends_on?.length ? ` (deps: ${t.depends_on.join(',')})` : '';
    console.log(`  ${t.id.padEnd(4)} [${t.kind}]${deps} ${t.name}`);
  }
  console.log('─'.repeat(70));

  const started = Date.now();
  const wf = await executeWorkflow(db, dag, workspace, objective, {
    pattern_id: patternId,
    autoApprove,
    onEvent: makeProgressPrinter(),
  });
  const duration = Math.round((Date.now() - started) / 1000);

  if (patternId) bumpPatternUsage(db, patternId);

  console.log('─'.repeat(70));
  console.log(`✓ Workflow completed`);
  console.log(`  ID:       ${wf.id}`);
  console.log(`  Status:   ${wf.status}`);
  console.log(`  Duration: ${duration}s`);
  console.log('─'.repeat(70));
} catch (err) {
  console.error('');
  console.error('✗ Workflow falhou');
  console.error(`  Erro:   ${err instanceof Error ? err.message : String(err)}`);

  // Find the workflow that was created for this run (saved to DB before failing)
  const lastWf = db.prepare(
    "SELECT id FROM workflows WHERE workspace = ? ORDER BY created_at DESC LIMIT 1"
  ).get(workspace);
  if (lastWf?.id) {
    console.error(`  ID:     ${lastWf.id}`);
    console.error(`  Resume: node scripts/resume-wf.mjs ${lastWf.id}`);
  }
  console.error('');
  // Set exitCode and let `finally` + the event loop drain naturally; calling
  // process.exit(1) here causes libuv "Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING)" on Windows when an in-flight HTTP / sqlite worker
  // handle is mid-close.
  process.exitCode = 1;
} finally {
  db.close();
}
