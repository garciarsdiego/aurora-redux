// /clear — clear the output ring buffer.
// Emits an `output_cleared` event for UI consumers; also calls
// resetOutputBuffer() directly so non-React consumers see the change.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';
import { resetOutputBuffer } from '../../state/outputBuffer.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ClearArgs = Record<string, never>;

export const clearCommand: SlashCommand<ClearArgs> = {
  name: 'clear',
  category: 'system',
  description: 'Clear the output pane',
  helpText: 'Clears all content from the output pane. Does not affect workflow state or history.',
  argSpec: [],
  autoExecute: true,
  mutates: false,

  async handler(_args: ClearArgs, _ctx: ReplCtx): Promise<SlashResult> {
    try {
      resetOutputBuffer();
    } catch {
      // resetOutputBuffer is sync and side-effect-only on a singleton; this
      // catch is purely defensive — we never want a UI clear to fail loudly.
    }
    return {
      events: [{ type: 'output_cleared' }],
    };
  },
};
