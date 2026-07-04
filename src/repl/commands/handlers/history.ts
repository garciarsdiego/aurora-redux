// /history [N=20] — show recent REPL input history for the active workspace.
// Loads from workspaces/<ws>/.repl-history (JSONL). Redaction is already applied
// at write time, so display is safe.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';
import { loadHistoryEntries, type HistoryEntry } from '../../input/history.js';

interface HistoryArgs {
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function formatEntries(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return 'No history entries yet.';
  const now = Date.now();
  const lines: string[] = [];
  for (const e of entries) {
    const ago = Math.floor((now - e.ts) / 1000);
    const tag = e.category ? `[${e.category}]` : '';
    lines.push(`  ${ago}s ago ${tag.padEnd(12)} ${e.raw}`);
  }
  return lines.join('\n');
}

export const historyCommand: SlashCommand<HistoryArgs> = {
  name: 'history',
  category: 'system',
  description: 'Show recent REPL input history',
  helpText: [
    'Displays the most recent N entries from the per-workspace REPL history.',
    'Secrets are redacted at write time.',
    '',
    'Examples:',
    '  /history',
    '  /history 50',
  ].join('\n'),
  argSpec: [
    { name: 'limit', type: 'number', required: false, default: DEFAULT_LIMIT,
      description: `Number of history entries to show (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
  ],
  autoExecute: true,
  mutates: false,

  async handler(args: HistoryArgs, ctx: ReplCtx): Promise<SlashResult> {
    const n = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    try {
      const all = await loadHistoryEntries(ctx.workspace);
      const slice = all.slice(-n);
      return { output: formatEntries(slice) };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  },
};
