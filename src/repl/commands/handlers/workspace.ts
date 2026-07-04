// /workspace [name?] — get or set the active workspace.
// On set: validates regex, calls loadWorkspaceEnv to layer .env, then
// updates the session store so other slices/handlers observe the change.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';
import { VALID_WORKSPACE_RE, loadWorkspaceEnv } from '../../../utils/workspace.js';

interface WorkspaceArgs {
  name?: string;
}

export const workspaceCommand: SlashCommand<WorkspaceArgs> = {
  name: 'workspace',
  category: 'state',
  description: 'Get or set the active workspace',
  helpText: [
    'Without arguments, prints the current active workspace.',
    'With a name argument, switches to that workspace and reloads its .env.',
    '',
    'Workspace names must match: /^[a-zA-Z0-9_-]+$/',
    '',
    'Examples:',
    '  /workspace',
    '  /workspace internal',
    '  /workspace client-acme',
  ].join('\n'),
  argSpec: [
    { name: 'name', type: 'workspace_name', required: false, description: 'Workspace name to switch to' },
  ],
  autoExecute: true,
  mutates: true,

  async handler(args: WorkspaceArgs, ctx: ReplCtx): Promise<SlashResult> {
    if (!args.name) {
      const ws = ctx.store?.session.workspace ?? ctx.workspace;
      return { output: `Current workspace: ${ws}` };
    }

    if (!VALID_WORKSPACE_RE.test(args.name)) {
      return {
        error: new Error(
          `Invalid workspace name: "${args.name}". ` +
          'Allowed: alphanumeric, underscore, hyphen. No path separators or whitespace.',
        ),
      };
    }

    try {
      loadWorkspaceEnv(args.name);
    } catch (err) {
      // loadWorkspaceEnv only throws when the name fails the same regex we just
      // checked — so this is a hard internal mismatch. Surface the error so
      // the user sees it instead of a silent half-switch.
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (ctx.store) {
      ctx.store.session.setWorkspace(args.name);
    }

    return {
      output: `Workspace set to: ${args.name}`,
      events: [{ type: 'workspace.changed', payload: { workspace: args.name } }],
    };
  },
};
