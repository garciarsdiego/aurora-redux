// /model — interactive cascade picker (provider → model) per role, OR direct
// shortcut form for power users / scripted setup.
//
// Usage:
//   /model                            → opens cascade picker (target → provider → model)
//   /model task                       → opens picker pre-targeted at TASK
//   /model task cc/claude-opus-4-7    → sets TASK_MODEL directly, no picker
//   /model task cli:cursor            → sets TASK_EXECUTOR override (cli spawn)
//   /model all cc/claude-sonnet-4-6   → sets all 4 model targets
//   /model all cli:opencode           → sets all 4 executor overrides
//   /model reset                      → restores defaults + clears exec overrides
//
// Two lanes per target: a model (Omniroute LLM route) and an optional
// executor override (cli:<slug> → spawns a local CLI binary instead of an
// LLM call). Lanes are independent — you can set both to run OpenCode with
// Claude Sonnet as its backend via OpenCode's -m flag.
//
// Persistence: volatile per session (process.env mutation only). The S key
// inside the picker for save-to-.env is a follow-up — Example asked to dogfood
// volatile first to see which combinations are worth persisting.
import type { SlashCommand, SlashResult, ReplCtx } from '../types.js';

interface ModelArgs {
  target?: string;
  model_id?: string;
}

const TARGETS = ['DECOMPOSER', 'TASK', 'REVIEWER', 'CONSOLIDATOR', 'ALL'] as const;
type Target = typeof TARGETS[number];

const ENV_KEY: Readonly<Record<Exclude<Target, 'ALL'>, string>> = {
  DECOMPOSER: 'DECOMPOSER_MODEL',
  TASK: 'TASK_MODEL',
  REVIEWER: 'REVIEWER_MODEL',
  CONSOLIDATOR: 'CONSOLIDATOR_MODEL',
};

const EXEC_ENV_KEY: Readonly<Record<Exclude<Target, 'ALL'>, string>> = {
  DECOMPOSER: 'DECOMPOSER_EXECUTOR',
  TASK: 'TASK_EXECUTOR',
  REVIEWER: 'REVIEWER_EXECUTOR',
  CONSOLIDATOR: 'CONSOLIDATOR_EXECUTOR',
};

const DEFAULT_MODEL: Readonly<Record<Exclude<Target, 'ALL'>, string>> = {
  DECOMPOSER: 'claude/claude-opus-4-6',
  TASK: 'claude/claude-sonnet-4-6',
  REVIEWER: 'claude/claude-sonnet-4-6',
  CONSOLIDATOR: 'claude/claude-sonnet-4-6',
};

// Loose id check — accepts provider/model, provider:tool (PAL), and cli:slug.
const MODEL_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*[/:][a-zA-Z0-9._/-]+$/;

function normalizeTarget(input: string | undefined): Target | null {
  if (!input) return null;
  const upper = input.toUpperCase();
  return (TARGETS as readonly string[]).includes(upper) ? (upper as Target) : null;
}

/**
 * Route a selection to the MODEL or EXECUTOR lane based on the id shape:
 *   cli:<slug>  → sets <TARGET>_EXECUTOR (cli_spawn override)
 *   anything else → sets <TARGET>_MODEL (Omniroute LLM route)
 */
function applyOne(target: Exclude<Target, 'ALL'>, id: string): 'model' | 'executor' {
  if (id.startsWith('cli:')) {
    process.env[EXEC_ENV_KEY[target]] = id;
    return 'executor';
  }
  process.env[ENV_KEY[target]] = id;
  return 'model';
}

function applyAll(id: string): 'model' | 'executor' {
  let lane: 'model' | 'executor' = 'model';
  for (const t of TARGETS) {
    if (t === 'ALL') continue;
    lane = applyOne(t, id);
  }
  return lane;
}

function resetAll(): void {
  for (const t of TARGETS) {
    if (t === 'ALL') continue;
    process.env[ENV_KEY[t]] = DEFAULT_MODEL[t];
    delete process.env[EXEC_ENV_KEY[t]];
  }
}

function readCurrent(): string {
  const lines: string[] = ['Current configuration (this session):'];
  for (const t of TARGETS) {
    if (t === 'ALL') continue;
    const model = process.env[ENV_KEY[t]] ?? DEFAULT_MODEL[t];
    const exec = process.env[EXEC_ENV_KEY[t]];
    const execFrag = exec ? `  ▸ exec=${exec}` : '';
    lines.push(`  ${t.padEnd(13)} model=${model}${execFrag}`);
  }
  lines.push('');
  lines.push('Run /model with no args to open the picker.');
  lines.push('Pick a cli:<slug> entry in the picker to set an executor override.');
  return lines.join('\n');
}

export const modelCommand: SlashCommand<ModelArgs> = {
  name: 'model',
  category: 'config',
  description: 'Open model picker (cascade) or set model for a role directly',
  helpText: [
    '/model                            open the cascade picker (target → provider → model)',
    '/model show                       print current configuration without picker',
    '/model <target>                   open picker pre-targeted at one role',
    '/model <target> <model_id>        set directly without picker',
    '/model all <model_id>             set DECOMPOSER, TASK, REVIEWER, CONSOLIDATOR all to model',
    '/model reset                      restore default models for all 4 targets',
    '',
    'Targets: decomposer, task, reviewer, consolidator, all',
    '',
    'Examples:',
    '  /model task cc/claude-opus-4-7',
    '  /model all gemini-cli/gemini-3.1-pro-preview',
    '  /model reset',
    '',
    'Persistence: volatile (this REPL session only). Use /set-config <KEY> <value>',
    'or edit workspaces/<ws>/.env to persist across sessions.',
  ].join('\n'),
  argSpec: [
    { name: 'target', type: 'string', required: false, description: 'decomposer | task | reviewer | consolidator | all | reset | show' },
    { name: 'model_id', type: 'model_id', required: false, description: 'Model id (provider/model-name)' },
  ],
  autoExecute: true,
  mutates: true,

  async handler(args: ModelArgs, ctx: ReplCtx): Promise<SlashResult> {
    // No args → open the cascade picker via modal stack.
    if (!args.target) {
      if (ctx.store) {
        ctx.store.ui.pushModal('model-picker');
        return { output: '' }; // modal renders the UI; nothing to echo here
      }
      // Fallback when no store wired (tests / pre-bootstrap). Print current.
      return { output: readCurrent() };
    }

    const targetRaw = args.target.toLowerCase();

    // /model show — print current config without opening picker.
    if (targetRaw === 'show') {
      return { output: readCurrent() };
    }

    // /model reset — restore defaults + clear executor overrides for all 4.
    if (targetRaw === 'reset') {
      resetAll();
      return {
        output: 'All 4 targets reset (models to defaults, executor overrides cleared).',
        events: [{ type: 'model.reset', payload: {} }],
      };
    }

    const target = normalizeTarget(args.target);
    if (target === null) {
      return {
        error: new Error(
          `Unknown target '${args.target}'. Valid: decomposer, task, reviewer, consolidator, all, reset, show.`,
        ),
      };
    }

    // /model <target>  → open picker pre-targeted (uses modelProps to seed step)
    if (!args.model_id) {
      if (ctx.store) {
        ctx.store.ui.pushModal('model-picker');
        return { output: '' };
      }
      return { output: readCurrent() };
    }

    // /model <target> <model_id> → direct set, no picker.
    if (!MODEL_ID_RE.test(args.model_id)) {
      return {
        error: new Error(
          `Invalid model id: "${args.model_id}". Expected: provider/model-name (e.g. cc/claude-sonnet-4-6) or provider:tool (e.g. pal:consensus).`,
        ),
      };
    }

    if (target === 'ALL') {
      const lane = applyAll(args.model_id);
      return {
        output: `All 4 targets: ${lane} set to ${args.model_id}`,
        events: [{ type: 'model.set_all', payload: { model: args.model_id, lane } }],
      };
    }

    const lane = applyOne(target, args.model_id);
    return {
      output: `${target} ${lane} set to: ${args.model_id}`,
      events: [{ type: 'model.set', payload: { target, model: args.model_id, lane } }],
    };
  },
};
