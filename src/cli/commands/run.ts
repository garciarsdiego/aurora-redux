import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { decompose } from '../../brain/decomposer.js';
import { executeWorkflow, continueWorkflowExecution } from '../../brain/executor.js';
import { matchPattern } from '../../brain/patternMatcher.js';
import { listPatterns, bumpPatternUsage } from '../../patterns/store.js';
import { findExecutingWorkflow } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkspaceEnv } from '../../utils/workspace.js';
import type { Dag } from '../../types/index.js';
import { makeProgressPrinter } from '../progress-printer.js';
import { printWorkflowSummary, reportRunError } from '../run-summary.js';

export function registerRun(program: Command): void {
  program
    .command('run <objective>')
    .description('Decompose an objective and execute it as a workflow')
    .requiredOption('-w, --workspace <name>', 'workspace to run in')
    .option('--auto-approve', 'bypass all HITL gates automatically')
    .option('--no-pattern', 'skip pattern matching and always generate a fresh DAG')
    // Commander maps `--no-pattern` to `options.pattern = false` (default true).
    .action(async (objective: string, options: { workspace: string; autoApprove?: boolean; pattern?: boolean }) => {
      loadWorkspaceEnv(options.workspace);
      const db = initDb(getDbPath());
      try {
        const existing = findExecutingWorkflow(db, options.workspace, objective);

        const onEvent = makeProgressPrinter();

        if (existing) {
          console.log(`Workflow em execução detectado — retomando ${existing.id}...`);
          const started = Date.now();
          const wf = await continueWorkflowExecution(db, existing, {
            autoApprove: options.autoApprove ?? false,
            onEvent,
          });
          const duration = Date.now() - started;

          printWorkflowSummary({
            title: '✓ Workflow retomado e completado',
            id: wf.id,
            workspace: wf.workspace,
            status: wf.status,
            durationMs: duration,
          });
        } else {
          let dag: Dag;
          let patternId: string | undefined;

          if (options.pattern === false) {
            console.log('Gerando DAG novo (--no-pattern)...');
            dag = await decompose(objective);
            console.log(`DAG: ${dag.tasks.length} tasks`);
          } else {
            const patterns = listPatterns(db, options.workspace);
            const match = await matchPattern(objective, patterns);

            if (match.action === 'use') {
              console.log(`Usando pattern: ${match.pattern.name}`);
              dag = JSON.parse(match.pattern.dag_json) as Dag;
              patternId = match.pattern.id;
            } else {
              console.log('Gerando DAG novo...');
              dag = await decompose(objective);
              console.log(`DAG: ${dag.tasks.length} tasks`);
            }
          }

          const started = Date.now();
          const wf = await executeWorkflow(db, dag, options.workspace, objective, {
            pattern_id: patternId,
            autoApprove: options.autoApprove ?? false,
            onEvent,
          });
          const duration = Date.now() - started;

          if (patternId) {
            bumpPatternUsage(db, patternId);
          }

          printWorkflowSummary({
            title: '✓ Workflow completado',
            id: wf.id,
            workspace: wf.workspace,
            status: wf.status,
            tasks: dag.tasks.length,
            durationMs: duration,
            pattern: patternId,
          });
        }
      } catch (err) {
        // reportRunError sets exitCode (never process.exit) — see the libuv
        // rationale in src/cli/run-summary.ts.
        reportRunError(err);
      } finally {
        db.close();
      }
    });
}
