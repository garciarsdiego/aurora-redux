// REPL Level D — entry point (D-H2.022).
// See docs/plans/REPL-LEVEL-D.md § 3.2 (file tree).
//
// Boot order:
//   1. Print "omniforge" banner immediately (sub-100 ms perceived latency).
//   2. Dynamically import bootstrap so heavy modules don't pay the import cost twice.
//   3. Run bootstrap() — opens DB, registers signal handlers, validates workspace.
//   4. Mount <App/> with exitOnCtrlC: false; REPL traps Ctrl+C in useInput.
//   5. Any failure → write to stderr and exit(1).
//
// Bundled by tsup into dist/repl/bundle.mjs.

import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { registerAllCommands } from './commands/registerAll.js';
import type { BootConfig } from './bootstrap.js';

const BANNER = 'omniforge\n';

/**
 * Read boot config from env vars set by either:
 *   - bin/omniforge (argless TTY invocation): sets defaults
 *   - src/cli/commands/repl.ts: forwards Commander flags
 * All env vars are optional with sane defaults.
 */
function readBootConfig(): BootConfig {
  return {
    workspace: process.env['OMNIFORGE_REPL_WORKSPACE'] ?? 'internal',
    autoApprove: process.env['OMNIFORGE_REPL_AUTO_APPROVE'] === '1',
    ...(process.env['OMNIFORGE_REPL_MODEL']
      ? { modelOverride: process.env['OMNIFORGE_REPL_MODEL'] }
      : {}),
    ephemeral: process.env['OMNIFORGE_REPL_EPHEMERAL'] === '1',
    noDaemon: process.env['OMNIFORGE_REPL_NO_DAEMON'] === '1',
    requireDaemon: process.env['OMNIFORGE_REPL_REQUIRE_DAEMON'] === '1',
  };
}

async function main(): Promise<void> {
  // Banner first — visible before any heavy import resolves.
  // Skip if bin/omniforge already printed it (avoid duplicate).
  if (process.env['OMNIFORGE_BANNER_PRINTED'] !== '1') {
    process.stdout.write(BANNER);
    process.env['OMNIFORGE_BANNER_PRINTED'] = '1';
  }

  let historySnapshot: readonly string[] = [];
  try {
    const { bootstrap } = await import('./bootstrap.js');
    await bootstrap(readBootConfig());

    // Preload history for PromptInput ↑/↓ navigation.
    const { loadHistoryEntries } = await import('./input/history.js');
    const entries = await loadHistoryEntries(readBootConfig().workspace);
    historySnapshot = entries.map((e) => e.raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[repl] bootstrap failed: ${msg}\n`);
    process.exit(1);
  }

  // Registry must be populated before <App/> renders the slash menu.
  registerAllCommands();

  // exitOnCtrlC: false — the REPL traps Ctrl+C to cancel the current operation
  // rather than terminate the process (D-H2.022).
  render(<App initialHistory={historySnapshot} />, { exitOnCtrlC: false });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[repl] fatal: ${msg}\n`);
  process.exit(1);
});
