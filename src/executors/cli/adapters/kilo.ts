// =============================================================================
// adapters/kilo.ts — `cli:kilo` spec builder.
//
// `kilo run --auto "<prompt>"` — --auto is mandatory for spawned use:
// without it kilo asks for permission interactively on every tool call
// and hangs since our stdin is closed. When CLI_SAFE_MODE=true this
// CLI will hang exactly like claude-code/kimi do in safe mode; the
// expected behavior is "don't use cli:kilo in safe mode".
// =============================================================================

import type { CliSpec } from '../types.js';
import { kiloBin } from '../bin-resolver.js';

export interface KiloSpecInputs {
  safeMode: boolean;
}

export function buildKiloSpec(inputs: KiloSpecInputs): CliSpec {
  const { safeMode } = inputs;
  const args = ['run'];
  if (!safeMode) args.push('--auto');
  return { bin: kiloBin(), args, streamJson: false, promptDelivery: 'arg' };
}
