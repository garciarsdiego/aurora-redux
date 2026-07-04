#!/usr/bin/env node
/**
 * Resume a workflow by ID — bypasses the MCP tool chain to run the workflow
 * in a standalone Node process. Use this when a workflow was stuck/orphaned
 * because the Claude Code session crashed, taking its MCP server down with it.
 *
 * Usage (from a separate terminal, NOT inside Claude Code):
 *   cd C:\Users\Example User\Desktop\omniforge
 *   node scripts/resume-wf.mjs <workflow_id>
 *
 * The process runs until the workflow completes or errors. It is completely
 * decoupled from any Claude Code instance — killing Claude Code has no effect.
 */

process.env.DOTENV_CONFIG_QUIET = 'true';

const wfId = process.argv[2];
if (!wfId || !wfId.startsWith('wf_')) {
  console.error('Usage: node scripts/resume-wf.mjs <workflow_id>');
  process.exit(1);
}

const { initDb } = await import('../dist/db/client.js');
const { getDbPath } = await import('../dist/utils/config.js');
const { loadWorkflowById, loadWorkflowTasks } = await import('../dist/db/persist.js');
const { resumeWorkflow } = await import('../dist/brain/executor/resume.js');
const { loadWorkspaceEnv } = await import('../dist/utils/workspace.js');

let wf;
const db = initDb(getDbPath());
try {
  wf = loadWorkflowById(db, wfId);
  if (!wf) {
    console.error(`Workflow not found: ${wfId}`);
    process.exit(2);
  }

  const tasks = loadWorkflowTasks(db, wfId);
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  console.log('─'.repeat(70));
  console.log(`Resuming: ${wfId}`);
  console.log(`Status:   ${wf.status}`);
  console.log(`Workspace:${wf.workspace}`);
  console.log(`Tasks:    ${JSON.stringify(byStatus)}`);
  console.log(`Objective:${wf.objective.slice(0, 120)}${wf.objective.length > 120 ? '…' : ''}`);
  console.log('─'.repeat(70));
} finally {
  db.close();
}

loadWorkspaceEnv(wf.workspace);

try {
  const started = Date.now();
  const result = await resumeWorkflow(wfId, { autoApprove: true });
  const duration = Math.round((Date.now() - started) / 1000);

  const db2 = initDb(getDbPath());
  let finalByStatus = {};
  try {
    const finalTasks = loadWorkflowTasks(db2, wfId);
    for (const t of finalTasks) finalByStatus[t.status] = (finalByStatus[t.status] ?? 0) + 1;
  } finally {
    db2.close();
  }

  console.log('─'.repeat(70));
  console.log(`✓ Done — status: ${result.status}`);
  console.log(`  Duration: ${duration}s`);
  console.log(`  Tasks:    ${JSON.stringify(finalByStatus)}`);
  console.log('─'.repeat(70));
} catch (err) {
  console.error('');
  console.error('✗ Resume falhou');
  console.error(`  Erro:   ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  ID:     ${wfId}`);
  console.error(`  Tente:  node scripts/resume-wf.mjs ${wfId}`);
  console.error('');
  process.exit(1);
}
