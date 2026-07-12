// /resume <wf_id> — resume a paused or failed workflow.
// Loads the workflow from the DB, then drives resumeWorkflow(workflowId) with
// auto-approve so the REPL session does not block on plan-gate prompts.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';
import { loadWorkflowById } from '../../../db/persist.js';
import { resumeWorkflow } from '../../../brain/executor/resume.js';
import { toError } from '../../utils/errors.js';

interface ResumeArgs {
  wf_id: string;
}

export const resumeCommand: SlashCommand<ResumeArgs> = {
  name: 'resume',
  category: 'workflow',
  description: 'Resume a paused or failed workflow',
  helpText: [
    'Resume execution of a workflow that was paused, hit a HITL gate,',
    'or failed and is awaiting manual retry.',
    '',
    'Example:',
    '  /resume wf_abc123',
  ].join('\n'),
  argSpec: [
    { name: 'wf_id', type: 'workflow_id', required: true,
      description: 'ID of the workflow to resume (e.g. wf_abc123)' },
  ],
  autoExecute: false,
  mutates: true,

  async handler(args: ResumeArgs, ctx: ReplCtx): Promise<SlashResult> {
    if (!ctx.db) {
      // Resume is fully implemented below; this branch is the fallback for REPL
      // bootstrap paths where the DB handle is not yet wired into the slash
      // command context (rare — only seen during early startup tests).
      return {
        output: [
          `Resume request received for: ${args.wf_id}`,
          'Cannot execute: REPL has not wired a DB handle yet (startup race).',
        ].join('\n'),
      };
    }

    let workflow;
    try {
      workflow = loadWorkflowById(ctx.db, args.wf_id);
    } catch (err) {
      return { error: toError(err) };
    }
    if (!workflow) {
      return { error: new Error(`Workflow not found: ${args.wf_id}`) };
    }

    try {
      const finalWf = await resumeWorkflow(args.wf_id, {
        db: ctx.db,
        autoApprove: true,
        onEvent: () => { /* MC: pipe to OutputPane */ },
      });
      return {
        output: `Resumed ${finalWf.id} — final status: ${finalWf.status}`,
        events: [{ type: 'workflow.resumed', payload: { workflow_id: finalWf.id, status: finalWf.status } }],
      };
    } catch (err) {
      return { error: toError(err) };
    }
  },
};
