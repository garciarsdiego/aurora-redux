// /run "objective" [--workspace=name] [--auto-approve] [--no-pattern]
//
// Real wiring (this commit): handler kicks off runWorkflow ASYNCHRONOUSLY and
// returns immediately. Progress is streamed into the outputBuffer via the
// runner's onEvent callback — REPL stays responsive (user can type other
// commands, e.g. /status, while the workflow runs in background).
//
// autoApprove default = TRUE (Example's permissive policy 2026-04-23). HITL
// modal-resolver bridge ships in v0.4; --no-auto throws today with a pointer.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';
import { runWorkflow } from '../../services/runner.js';
import { appendOutput } from '../../state/outputBuffer.js';

interface RunArgs {
  objective: string;
  workspace?: string;
  auto_approve?: boolean;
  no_pattern?: boolean;
}

export const runCommand: SlashCommand<RunArgs> = {
  name: 'run',
  category: 'workflow',
  description: 'Execute a workflow from an objective text',
  helpText: [
    'Submit an objective to the Omniforge executor. Runs in background;',
    'progress streams into the output pane.',
    '',
    'Examples:',
    '  /run "build a TODO app"',
    '  /run "analyse codebase" --workspace internal',
    '  /run "fresh decompose" --no-pattern',
    '',
    'You can also just type the objective without /run (free text → /run).',
  ].join('\n'),
  argSpec: [
    { name: 'objective',    type: 'string',         required: true,  description: 'Natural language objective for the workflow' },
    { name: 'workspace',    type: 'workspace_name', required: false, description: 'Workspace to run in (defaults to current)' },
    { name: 'auto_approve', type: 'boolean',        required: false, default: true,  description: 'Skip HITL gates (default true while modal-resolver pending)' },
    { name: 'no_pattern',   type: 'boolean',        required: false, default: false, description: 'Force fresh decompose (skip pattern matcher)' },
  ],
  autoExecute: false,
  mutates: true,

  async handler(args: RunArgs, ctx: ReplCtx): Promise<SlashResult> {
    const objective = args.objective?.trim() ?? '';
    if (objective.length === 0) {
      return {
        error: new Error(
          'Missing objective. Usage: /run "your objective text" — or just type the text without /run.',
        ),
      };
    }
    const ws = args.workspace ?? ctx.store?.session.workspace ?? ctx.workspace;

    // Kick off async; do NOT await — REPL stays responsive while the workflow
    // runs. Errors are caught and surfaced to the output pane via the runner's
    // own appendOutput calls; we attach a defensive .catch() so any escape
    // does not become an unhandledRejection.
    const opts = {
      objective,
      workspace: ws,
      autoApprove: args.auto_approve !== false, // default true
      noPattern: args.no_pattern === true,
    };

    appendOutput(`/run started: ${objective.slice(0, 100)}${objective.length > 100 ? '…' : ''} @ ws:${ws}`, 'info');

    // Fire and forget; the runner streams its own progress into outputBuffer.
    void runWorkflow(opts).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(`runner error (caught at handler): ${msg}`, 'error');
    });

    return {
      output: '', // runner already wrote the kickoff line; nothing else here
      events: [{ type: 'workflow.start_requested', payload: { workspace: ws, objective } }],
    };
  },
};
