import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkflowById } from '../../db/persist.js';
import { resumeWorkflow } from '../../brain/executor/resume.js';
import { loadWorkspaceEnv } from '../../utils/workspace.js';
import { makeProgressPrinter } from '../progress-printer.js';

export function registerResume(program: Command): void {
  program
    .command('resume <workflow_id>')
    .description('Resume a paused, failed, or cancelled workflow')
    .option('--skip-failed-steps', 'mark failed tasks as skipped instead of retrying the latest failure')
    .option('--auto-approve', 'bypass HITL gates (same as run --auto-approve)')
    .action(
      async (
        workflowId: string,
        opts: { skipFailedSteps?: boolean; autoApprove?: boolean },
      ) => {
        const db = initDb(getDbPath());
        let workspace: string;
        try {
          const wf = loadWorkflowById(db, workflowId);
          if (!wf) {
            console.error(`Workflow not found: ${workflowId}`);
            process.exitCode = 2;
            return;
          }
          workspace = wf.workspace;
        } finally {
          db.close();
        }

        loadWorkspaceEnv(workspace);
        const onEvent = makeProgressPrinter();

        try {
          const started = Date.now();
          const finalWf = await resumeWorkflow(workflowId, {
            skipFailedSteps: opts.skipFailedSteps === true,
            autoApprove: opts.autoApprove === true,
            onEvent,
          });
          const duration = Date.now() - started;
          console.log('');
          console.log('✓ Workflow resumed');
          console.log(`  ID:        ${finalWf.id}`);
          console.log(`  Status:    ${finalWf.status}`);
          console.log(`  Duração:   ${duration}ms`);
        } catch (err) {
          console.error('Erro:', err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      },
    );
}
