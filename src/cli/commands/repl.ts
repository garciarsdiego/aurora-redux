// REPL Commander entry — registers `omniforge repl` subcommand.
// The TTY-aware shim in bin/omniforge routes argless invocations directly to
// dist/repl/bundle.js; this command exists so users can ALSO invoke explicitly
// (`omniforge repl --workspace prod`) and pass flags.
//
// Why a thin wrapper instead of inlining bootstrap/render here?
//   - The REPL bundle (dist/repl/bundle.js) is built by tsup separately so
//     cold start is ~210ms instead of ~480ms with full tsc imports.
//   - This command path goes through Commander → tsc-compiled dist/cli/, which
//     means it WOULDN'T benefit from the tsup bundle. So we delegate via
//     dynamic import to the bundle to keep cold start consistent.
//
// See docs/plans/REPL-LEVEL-D.md § 3.6 (command registration).
import type { Command } from 'commander';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ReplOpts {
  readonly workspace?: string;
  readonly autoApprove?: boolean;
  readonly model?: string;
  readonly ephemeral?: boolean;
  /** Commander maps `--no-daemon` to `daemon = false` (default true). */
  readonly daemon?: boolean;
  readonly requireDaemon?: boolean;
}

export function registerRepl(program: Command): void {
  program
    .command('repl')
    .description('Open the interactive REPL TUI (default action of bare `omniforge`)')
    .option('-w, --workspace <name>', 'workspace to attach to', 'internal')
    .option('--auto-approve', 'bypass HITL gates automatically (use with care)')
    .option('-m, --model <id>', 'override the active task model for this session')
    .option('--ephemeral', 'use a temporary database (auto-cleanup on exit)')
    .option('--no-daemon', 'force in-process mode (rejects boot if daemon detected)')
    .option('--require-daemon', 'fail hard if daemon is not reachable')
    .action(async (opts: ReplOpts) => {
      // Pre-Ink banner — visible in <100ms regardless of bundle load time.
      process.stdout.write('omniforge\n');

      // Path resolution: this file lives in dist/cli/commands/, the REPL bundle
      // in dist/repl/. Resolve relative.
      const here = dirname(fileURLToPath(import.meta.url));
      const bundlePath = resolve(here, '..', '..', 'repl', 'bundle.js');

      // Stash flags on env so the bundle's main() can read them without us
      // having to reach into its module shape.
      process.env['OMNIFORGE_REPL_WORKSPACE'] = opts.workspace ?? 'internal';
      process.env['OMNIFORGE_REPL_AUTO_APPROVE'] = opts.autoApprove ? '1' : '0';
      if (opts.model) process.env['OMNIFORGE_REPL_MODEL'] = opts.model;
      process.env['OMNIFORGE_REPL_EPHEMERAL'] = opts.ephemeral ? '1' : '0';
      process.env['OMNIFORGE_REPL_NO_DAEMON'] = opts.daemon === false ? '1' : '0';
      process.env['OMNIFORGE_REPL_REQUIRE_DAEMON'] = opts.requireDaemon ? '1' : '0';

      try {
        await import(bundlePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[omniforge] REPL bundle failed to load: ${msg}\n`);
        process.stderr.write(`[omniforge] Run \`pnpm build\` to (re)build dist/repl/bundle.js.\n`);
        process.exit(1);
      }
    });
}
