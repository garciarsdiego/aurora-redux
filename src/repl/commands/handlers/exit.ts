// /exit (/quit) — graceful REPL shutdown.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ExitArgs = Record<string, never>;

export const exitCommand: SlashCommand<ExitArgs> = {
  name: 'exit',
  aliases: ['quit'],
  category: 'system',
  description: 'Exit the REPL',
  helpText: 'Exits the REPL cleanly. Any background workflows continue in the daemon.\nAlias: /quit',
  argSpec: [],
  autoExecute: true,
  mutates: true,

  async handler(_args: ExitArgs, _ctx: ReplCtx): Promise<SlashResult> {
    return { exitCode: 0 };
  },
};
