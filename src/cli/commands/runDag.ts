// run-dag — execute a YAML/JSON DAG file directly, skipping import +
// pattern matching. Faster path when you already have the file you want.
//
// Modes (combinable):
//   --plan   show DAG summary + tasks table, prompt Y/N before executing
//   --edit   open file in $EDITOR (or notepad/nano default), re-validate after save
//
// Examples:
//   omniforge run-dag tetris.yaml -w internal --auto-approve
//   omniforge run-dag tetris.yaml -w internal --plan        # review then run
//   omniforge run-dag tetris.yaml -w internal --edit --plan # edit, review, run
//
// Why a separate command (vs. extending `run --from-file`):
// `run` semantically means "decompose this objective into a DAG and execute".
// `run-dag` means "execute this already-built DAG". Different mental model,
// different flag set, different validation surface — cleaner as siblings.

import { readFileSync, existsSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { load as yamlLoad } from 'js-yaml';
import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { executeWorkflow } from '../../brain/executor.js';
import { DagSchema } from '../../types/schemas.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkspaceEnv } from '../../utils/workspace.js';
import { makeProgressPrinter } from '../progress-printer.js';
import { printWorkflowSummary, reportRunError } from '../run-summary.js';
import type { Dag } from '../../types/index.js';

interface RunDagOptions {
  workspace: string;
  objective?: string;
  autoApprove?: boolean;
  plan?: boolean;
  edit?: boolean;
  editor?: string;
}

/** Read + parse + Zod-validate a DAG file. Throws on any failure. */
export function readAndValidateDag(file: string): Dag {
  if (!existsSync(file)) {
    throw new Error(`file not found: ${file}`);
  }
  const ext = extname(file).toLowerCase();
  if (!['.json', '.yaml', '.yml'].includes(ext)) {
    throw new Error(`unsupported extension '${ext}' — use .json, .yaml, or .yml`);
  }
  const raw = readFileSync(file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(raw) : yamlLoad(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse ${ext === '.json' ? 'JSON' : 'YAML'}: ${msg}`);
  }
  const result = DagSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`DAG schema validation failed:\n${lines}`);
  }
  return result.data;
}

type DagTask = Dag['tasks'][number];

/** Distinct non-empty values of `pick` across tasks, sorted. */
function collectDistinct(tasks: readonly DagTask[], pick: (t: DagTask) => string | null | undefined): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    const value = pick(t);
    if (value) set.add(value);
  }
  return [...set].sort();
}

/** Build the human-readable plan summary + per-task table. */
export function formatPlan(dag: Dag, file: string, opts: { workspace: string; autoApprove?: boolean }): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`DAG Plan: ${file}`);
  lines.push(`  Workspace:  ${opts.workspace}`);
  lines.push(`  Tasks:      ${dag.tasks.length}`);

  // Kinds breakdown
  const kindCounts = new Map<string, number>();
  for (const t of dag.tasks) kindCounts.set(t.kind, (kindCounts.get(t.kind) ?? 0) + 1);
  lines.push(`  Kinds:      ${[...kindCounts].map(([k, n]) => `${k} (${n})`).join(', ')}`);

  // Distinct models
  const models = collectDistinct(dag.tasks, (t) => t.model);
  if (models.length > 0) lines.push(`  Models:     ${models.join(', ')}`);

  // CLI hints
  const cliHints = collectDistinct(dag.tasks, (t) => (t.kind === 'cli_spawn' ? t.executor_hint : undefined));
  if (cliHints.length > 0) lines.push(`  CLI:        ${cliHints.join(', ')}`);

  // PAL tools
  const palHints = collectDistinct(dag.tasks, (t) => (t.kind === 'pal_call' ? t.executor_hint : undefined));
  if (palHints.length > 0) lines.push(`  PAL:        ${palHints.join(', ')}`);

  // tool_call tools
  const toolNames = collectDistinct(dag.tasks, (t) => (t.kind === 'tool_call' ? t.tool_name : undefined));
  if (toolNames.length > 0) lines.push(`  Tools:      ${toolNames.join(', ')}`);

  // HITL gates
  const hitlTasks = dag.tasks.filter((t) => t.hitl).map((t) => t.id);
  const hitlSuffix = opts.autoApprove ? ' (will be AUTO-APPROVED via --auto-approve)' : '';
  lines.push(`  HITL gates: ${hitlTasks.length}${hitlTasks.length > 0 ? ` at [${hitlTasks.join(', ')}]` : ''}${hitlSuffix}`);

  // Wall-clock cap
  const totalTimeoutS = dag.tasks.reduce((sum, t) => sum + (t.timeout_seconds ?? 300), 0);
  const wallMin = Math.ceil(totalTimeoutS / 60);
  lines.push(`  Max time:   up to ${wallMin} min (sum of task timeouts; actual usually 30-60% of cap)`);

  lines.push('');
  lines.push('Tasks:');
  for (const t of dag.tasks) {
    const deps = t.depends_on.length === 0 ? '(root)' : `← [${t.depends_on.join(', ')}]`;
    const hitlMark = t.hitl ? ' [HITL]' : '';
    const nameClip = t.name.length > 50 ? t.name.slice(0, 47) + '...' : t.name;
    lines.push(`  ${t.id.padEnd(4)} [${t.kind.padEnd(9)}] ${nameClip.padEnd(50)} ${deps}${hitlMark}`);
    const ref = t.executor_hint ?? t.model ?? (t.kind === 'tool_call' ? `tool=${t.tool_name}` : '');
    if (ref) lines.push(`        ${ref}`);
  }
  lines.push('');
  return lines.join('\n');
}

type Confirmation = 'execute' | 'view' | 'abort';

/** Prompt user for plan confirmation. Returns chosen action. */
export async function promptConfirmation(): Promise<Confirmation> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('Execute? [E]xecute / [V]iew full YAML / [A]bort (default E): ');
    const ans = answer.trim().toLowerCase();
    if (ans === 'v' || ans === 'view') return 'view';
    if (ans === 'a' || ans === 'abort' || ans === 'n' || ans === 'no') return 'abort';
    return 'execute'; // default + e/execute/y/yes/empty
  } finally {
    rl.close();
  }
}

const EDITOR_SHELL_METACHAR_RE = /[&|;<>()\r\n]/;

function splitCommandLine(command: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}

export interface EditorCommand {
  command: string;
  args: string[];
  shell: false;
}

export function buildEditorCommand(file: string, editorOverride?: string): EditorCommand {
  const editor =
    editorOverride ??
    process.env['EDITOR'] ??
    (process.platform === 'win32' ? 'notepad' : 'nano');
  if (EDITOR_SHELL_METACHAR_RE.test(editor)) {
    throw new Error('Editor command contains shell metacharacters; pass an executable plus plain args');
  }
  const parts = splitCommandLine(editor.trim());
  const command = parts[0];
  if (!command) {
    throw new Error('Editor command is empty');
  }
  return {
    command,
    args: [...parts.slice(1), file],
    shell: false,
  };
}

/** Open file in editor and wait for it to close. */
function openInEditor(file: string, editorOverride?: string): Promise<void> {
  const editor = buildEditorCommand(file, editorOverride);
  const display = [editor.command, ...editor.args.slice(0, -1)].join(' ').trim();
  console.log(`Opening ${file} in ${display} (close the editor when done)...`);
  return new Promise((resolve, reject) => {
    const child = spawn(editor.command, editor.args, { stdio: 'inherit', shell: editor.shell });
    child.on('close', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`editor '${editor.command}' exited with code ${code}`));
    });
    child.on('error', (err) => reject(new Error(`failed to launch '${editor.command}': ${err.message}`)));
  });
}

export function registerRunDag(program: Command): void {
  program
    .command('run-dag <file>')
    .description('Execute a DAG YAML/JSON file directly (skips import + pattern matching)')
    .requiredOption('-w, --workspace <name>', 'workspace to run in')
    .option('-o, --objective <text>', 'workflow objective (default: file basename)')
    .option('--auto-approve', 'bypass all HITL gates automatically')
    .option('--plan', 'show DAG summary and prompt for confirmation before executing')
    .option('--edit', 'open file in $EDITOR before executing (validates after save)')
    .option('--editor <cmd>', 'override editor command (default: $EDITOR or notepad/nano)')
    .action(async (file: string, options: RunDagOptions) => {
      // 1. Edit mode (optional) — open in editor, then continue
      if (options.edit) {
        try {
          await openInEditor(file, options.editor);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
      }

      // 2. Read + validate
      let dag: Dag;
      try {
        dag = readAndValidateDag(file);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // 3. Plan mode (optional) — print summary, prompt, optionally show full
      if (options.plan) {
        process.stdout.write(formatPlan(dag, file, options));
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const choice = await promptConfirmation();
          if (choice === 'abort') {
            console.log('Aborted by user. No workflow created.');
            return;
          }
          if (choice === 'view') {
            console.log('');
            console.log('--- Full DAG ---');
            console.log(readFileSync(file, 'utf-8'));
            console.log('--- end ---');
            console.log('');
            continue;
          }
          break; // execute
        }
      }

      // 4. Execute
      const objective = options.objective ?? basename(file, extname(file));
      loadWorkspaceEnv(options.workspace);
      const db = initDb(getDbPath());
      try {
        const onEvent = makeProgressPrinter();
        const started = Date.now();
        const wf = await executeWorkflow(db, dag, options.workspace, objective, {
          autoApprove: options.autoApprove ?? false,
          onEvent,
        });
        const duration = Date.now() - started;

        printWorkflowSummary({
          title: '✓ Workflow completado',
          id: wf.id,
          workspace: wf.workspace,
          status: wf.status,
          tasks: dag.tasks.length,
          durationMs: duration,
          artifacts: `workspaces/${wf.workspace}/runs/${wf.id}/`,
        });
      } catch (err) {
        // reportRunError sets exitCode (never process.exit) so the event loop
        // drains naturally — see src/cli/run-summary.ts.
        reportRunError(err);
      } finally {
        db.close();
      }
    });
}
