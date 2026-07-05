// Tests for resolveCliSpec — covers all 7 supported `cli:<slug>` hints,
// safe mode + stream-json env toggles, and OpenCode's model-override path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCliSpawnOptions, resolveCliSpec, withCliPermissionMode } from '../../src/executors/cli.js';
import type { Task } from '../../src/types/index.js';
import { buildTaskExecutionContext, resolveTaskExecutionContext } from '../../src/utils/execution-context.js';

// Reset env vars the spec resolver reads so tests are deterministic regardless
// of what the dev shell is leaking in.
const ENV_KEYS = ['CLI_SAFE_MODE', 'CLI_OUTPUT_FORMAT', 'OMNIFORGE_DAEMON_CHILD', 'OMNIFORGE_MCP_SAFE_MODE'] as const;
let snapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k]!;
  }
});

function taskWithModel(model: string | null): Pick<Task, 'model'> {
  return { model };
}

function expectCodexBin(bin: string): void {
  if (process.platform === 'win32') {
    expect(bin.toLowerCase()).toMatch(/codex(\.exe|\.cmd)?$/);
    return;
  }
  expect(bin).toBe('codex');
}

/**
 * Tolerant bin assertion: pre-existing tests assumed a clean PATH so
 * `expect(bin).toBe('claude')` was fine; on Example's dogfood machine the
 * memoized resolver returns the absolute path of the installed shim
 * (`C:\\Users\\Example User\\AppData\\...\\claude.cmd`). Match on the basename
 * with optional `.cmd`/`.exe` suffix so both shapes pass — keeps the test
 * meaningful (we still verify the right binary is selected) without
 * pinning the assertion to a specific install layout.
 */
function expectCliBin(bin: string, expected: string): void {
  if (process.platform === 'win32') {
    const re = new RegExp(`(^|[\\\\/])${expected}(\\.cmd|\\.exe)?$`, 'i');
    expect(bin).toMatch(re);
    return;
  }
  expect(bin).toBe(expected);
}

describe('resolveCliSpec — existing CLIs (stdin delivery)', () => {
  it('claude-code: stream-json + dangerously-skip by default', () => {
    const spec = resolveCliSpec('cli:claude-code');
    expectCliBin(spec.bin, 'claude');
    expect(spec.args).toContain('--print');
    expect(spec.args).toContain('--output-format');
    expect(spec.args).toContain('stream-json');
    expect(spec.args).toContain('--verbose');
    expect(spec.args).toContain('--dangerously-skip-permissions');
    expect(spec.streamJson).toBe(true);
    expect(spec.promptDelivery).toBe('stdin');
  });

  it('claude-code: CLI_OUTPUT_FORMAT=text disables stream-json', () => {
    process.env.CLI_OUTPUT_FORMAT = 'text';
    const spec = resolveCliSpec('cli:claude-code');
    expect(spec.streamJson).toBe(false);
    expect(spec.args).not.toContain('stream-json');
  });

  it('claude-code: CLI_SAFE_MODE=true drops --dangerously-skip-permissions', () => {
    process.env.CLI_SAFE_MODE = 'true';
    const spec = resolveCliSpec('cli:claude-code');
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
  });

  it('claude-code: daemon child defaults to safe mode unless explicitly overridden', () => {
    process.env.OMNIFORGE_DAEMON_CHILD = '1';
    const spec = resolveCliSpec('cli:claude-code');
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
  });

  it('claude-code: autonomous context overrides daemon safe mode for an approved dashboard run', () => {
    process.env.OMNIFORGE_DAEMON_CHILD = '1';
    const spec = withCliPermissionMode('autonomous', () => resolveCliSpec('cli:claude-code'));
    expect(spec.args).toContain('--dangerously-skip-permissions');
  });

  it('claude-code: safe context overrides CLI_SAFE_MODE=false', () => {
    process.env.CLI_SAFE_MODE = 'false';
    const spec = withCliPermissionMode('safe', () => resolveCliSpec('cli:claude-code'));
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
  });

  it('gemini (agy): --dangerously-skip-permissions + --model default + -p, arg delivery (Aurora-Redux 2026-07-04 — migrado do gemini-cli morto para Antigravity)', () => {
    const spec = resolveCliSpec('cli:gemini');
    // Antigravity CLI: bin é agy (gemini-cli foi desligado em 2026-06-18).
    expect(spec.bin.toLowerCase()).toMatch(/agy(\.exe|\.cmd)?$/);
    // -p is the LAST arg before runCliTask appends the prompt as the next argv element.
    expect(spec.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '-p']);
    expect(spec.promptDelivery).toBe('arg');
    expect(spec.streamJson).toBe(false);
  });

  it('gemini (agy): safe mode drops --dangerously-skip-permissions but keeps --model + -p', () => {
    process.env.CLI_SAFE_MODE = 'true';
    const spec = resolveCliSpec('cli:gemini');
    expect(spec.args).toEqual(['--model', 'gemini-3.1-pro', '-p']);
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
    expect(spec.promptDelivery).toBe('arg');
  });

  it('codex: exec subcommand + --dangerously-bypass-approvals-and-sandbox by default, stdin delivery', () => {
    const spec = resolveCliSpec('cli:codex');
    expectCodexBin(spec.bin);
    expect(spec.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config']);
    expect(spec.promptDelivery).toBe('stdin');
  });

  it('codex: safe mode drops bypass flag (returns to read-only sandbox + approval prompts)', () => {
    process.env.CLI_SAFE_MODE = 'true';
    const spec = resolveCliSpec('cli:codex');
    expectCodexBin(spec.bin);
    expect(spec.args).toEqual(['exec']);
    expect(spec.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('kimi: --print + --yolo + -w <repo-root> by default (workspace pinned to cwd)', () => {
    const spec = resolveCliSpec('cli:kimi');
    expect(spec.bin.toLowerCase()).toMatch(/kimi(-cli)?(\.exe|\.cmd)?$/);
    // Args have --print, --yolo, then -w followed by some absolute path (cwd at test time).
    // We assert structure rather than the exact path because cwd varies by CI/dev box.
    expect(spec.args[0]).toBe('--print');
    expect(spec.args[1]).toBe('--yolo');
    expect(spec.args[2]).toBe('-w');
    expect(spec.args[3]).toBeTruthy();
    expect(spec.promptDelivery).toBe('stdin');
  });

  it('kimi: safe mode drops --yolo (returns to interactive approval)', () => {
    process.env.CLI_SAFE_MODE = 'true';
    const spec = resolveCliSpec('cli:kimi');
    expect(spec.args).not.toContain('--yolo');
    expect(spec.args[0]).toBe('--print');
  });

  it('kimi: never emits --dangerously-skip-permissions (Kimi CLI rejects that flag)', () => {
    const spec = resolveCliSpec('cli:kimi');
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
  });

  it('unknown hint falls back to claude-code', () => {
    const spec = resolveCliSpec('cli:nonexistent');
    expectCliBin(spec.bin, 'claude');
    expect(spec.promptDelivery).toBe('stdin');
  });

  it('null/undefined hint falls back to claude-code', () => {
    expectCliBin(resolveCliSpec(null).bin, 'claude');
    expectCliBin(resolveCliSpec(undefined).bin, 'claude');
  });

  it('default claude-code hint defers to codex provider selected on the task', () => {
    const spec = resolveCliSpec('cli:claude-code', taskWithModel('codex/gpt-5.4'));
    expectCodexBin(spec.bin);
    expect(spec.args).toEqual(['exec', '--model', 'gpt-5.4', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config']);
  });

  it('null hint infers gemini CLI from a gemini-cli model id', () => {
    const spec = resolveCliSpec(null, taskWithModel('gemini-cli/gemini-2.5-pro'));
    expect(spec.bin.toLowerCase()).toMatch(/agy(\.exe|\.cmd)?$/);
    // Args order: skip-permissions (write permission), --model X, then -p (prompt-arg flag, prompt appended after).
    // 'gemini-2.5-pro' não casa /preview/i, então o id do task é mantido.
    expect(spec.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-2.5-pro', '-p']);
  });
});

describe('runCliTask spawn options', () => {
  it('does not use shell:true for CLI subprocesses', () => {
    const options = buildCliSpawnOptions();
    expect(options.shell).toBe(false);
    expect(options.env?.NO_COLOR).toBe('1');
  });

  it('pins cwd when execution context resolved one explicitly', () => {
    const options = buildCliSpawnOptions('C:\\tmp\\omniforge-project');
    expect(options.cwd).toBe('C:\\tmp\\omniforge-project');
  });
});

describe('software lane execution context', () => {
  it('builds a default run-root context for cli_spawn tasks', () => {
    const ctx = buildTaskExecutionContext({
      workspace: 'internal',
      workflowId: 'wf_123',
      taskId: 'tk_456',
    });
    expect(ctx.workspace_root).toContain('workspaces');
    expect(ctx.run_root).toContain('workspaces');
    expect(ctx.project_root).toBe(ctx.run_root);
    expect(ctx.cwd).toBe(ctx.run_root);
    expect(ctx.output_dir).toBe(ctx.run_root);
    expect(ctx.source_project_root).toBe(ctx.run_root);
    expect(ctx.source_cwd).toBe(ctx.run_root);
    expect(ctx.worktree_root).toBeNull();
    expect(ctx.worktree_branch).toBeNull();
    expect(ctx.lineage).toEqual({
      lane: 'software',
      source: 'workspace_run',
      workspace: 'internal',
      workflow_id: 'wf_123',
      task_id: 'tk_456',
    });
  });

  it('resolves persisted overrides from task.input_json without losing lineage', () => {
    const ctx = resolveTaskExecutionContext({
      id: 'tk_456',
      workflow_id: 'wf_123',
      workspace: 'internal',
      input_json: JSON.stringify({
        workspace: 'internal',
        execution_context: {
          project_root: 'repo',
          cwd: 'repo/packages/core',
          output_dir: 'artifacts',
          base_ref: 'main',
        },
      }),
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.project_root).toMatch(/repo$/);
    expect(ctx?.cwd).toMatch(/repo[\\/]packages[\\/]core$/);
    expect(ctx?.output_dir).toMatch(/artifacts$/);
    expect(ctx?.base_ref).toBe('main');
    expect(ctx?.source_project_root).toMatch(/repo$/);
    expect(ctx?.source_cwd).toMatch(/repo[\\/]packages[\\/]core$/);
    expect(ctx?.worktree_root).toBeNull();
    expect(ctx?.worktree_branch).toBeNull();
    expect(ctx?.lineage.task_id).toBe('tk_456');
  });
});

describe('resolveCliSpec — new CLIs (arg delivery)', () => {
  describe('cli:cursor', () => {
    it('default: agent -p --output-format text --force --trust, arg delivery, streamJson false', () => {
      const spec = resolveCliSpec('cli:cursor');
      // bin is memoized via resolveExistingBinary on Windows, so `toBe('agent')`
      // would only hold on a clean PATH. Assert ends-with so both shapes pass.
      expect(spec.bin.toLowerCase()).toMatch(/(^|[\\/])(cursor-agent|agent)(\.cmd|\.exe)?$/i);
      // Example smoke test 2026-05-01 — cursor hang fix: --output-format text +
      // --trust + extraEnv {CURSOR_INVOKED_AS, NODE_COMPILE_CACHE} were added.
      expect(spec.args).toEqual(['-p', '--output-format', 'text', '--force', '--trust']);
      expect(spec.promptDelivery).toBe('arg');
      expect(spec.streamJson).toBe(false);
      // extraEnv MUST set CURSOR_INVOKED_AS so the resolveSpawnTarget unwrap
      // doesn't strip it (root cause of the cursor-hang investigation).
      expect(spec.extraEnv?.CURSOR_INVOKED_AS).toBe('cursor-agent.cmd');
    });

    it('safe mode: drops --force and --trust, keeps --output-format text', () => {
      process.env.CLI_SAFE_MODE = 'true';
      const spec = resolveCliSpec('cli:cursor');
      expect(spec.args).toEqual(['-p', '--output-format', 'text']);
      expect(spec.args).not.toContain('--force');
      expect(spec.args).not.toContain('--trust');
    });
  });

  describe('cli:kilo', () => {
    it('default: kilo run --auto, arg delivery', () => {
      const spec = resolveCliSpec('cli:kilo');
      expectCliBin(spec.bin, 'kilo');
      expect(spec.args).toEqual(['run', '--auto']);
      expect(spec.promptDelivery).toBe('arg');
      expect(spec.streamJson).toBe(false);
    });

    it('safe mode: drops --auto (kilo will hang without it)', () => {
      process.env.CLI_SAFE_MODE = 'true';
      const spec = resolveCliSpec('cli:kilo');
      expect(spec.args).toEqual(['run']);
    });
  });

  describe('cli:opencode', () => {
    // Post-2026-05-05 fix: --dangerously-skip-permissions does not exist in
    // opencode 0.x (yargs error → empty output, ~70% of Onda 2/3 failures).
    // The flag was removed unconditionally; opencode `run` is headless by
    // design and does not gate per-action.
    it('default, no task.model: run only (post-fix — flag removed)', () => {
      const spec = resolveCliSpec('cli:opencode');
      expectCliBin(spec.bin, 'opencode');
      expect(spec.args).toEqual(['run']);
      expect(spec.args).not.toContain('--dangerously-skip-permissions');
      expect(spec.promptDelivery).toBe('arg');
    });

    it('drops -m for foreign provider (cc/* is Omniroute, not OpenCode)', () => {
      const spec = resolveCliSpec('cli:opencode', taskWithModel('cc/claude-sonnet-4-6'));
      // OpenCode does not have a `cc` provider — model arg dropped, default used.
      expect(spec.args).toEqual(['run']);
      expect(spec.args).not.toContain('-m');
    });

    it('keeps -m for known OpenCode provider (e.g. opencode-zen/glm-4.6)', () => {
      const spec = resolveCliSpec('cli:opencode', taskWithModel('opencode-zen/glm-4.6'));
      expect(spec.args).toEqual(['run', '-m', 'opencode-zen/glm-4.6']);
    });

    it('keeps -m for kimi-for-coding/* (OpenCode provider)', () => {
      const spec = resolveCliSpec('cli:opencode', taskWithModel('kimi-for-coding/kimi-k2'));
      expect(spec.args).toContain('-m');
      expect(spec.args).toContain('kimi-for-coding/kimi-k2');
    });

    it('null task.model does NOT inject -m flag', () => {
      const spec = resolveCliSpec('cli:opencode', taskWithModel(null));
      expect(spec.args).not.toContain('-m');
    });

    it('safe mode: drops -m for foreign provider (no behavior change, no permission flag to drop anymore)', () => {
      process.env.CLI_SAFE_MODE = 'true';
      // glm/* is not in OpenCode provider list; should drop the model arg.
      const spec = resolveCliSpec('cli:opencode', taskWithModel('glm/glm-4.6'));
      expect(spec.args).toEqual(['run']);
    });

    it('safe mode + known provider: keeps -m (and the bogus permission flag was already removed)', () => {
      process.env.CLI_SAFE_MODE = 'true';
      const spec = resolveCliSpec('cli:opencode', taskWithModel('zai/glm-4.6'));
      expect(spec.args).toEqual(['run', '-m', 'zai/glm-4.6']);
    });
  });
});

// Example smoke test 2026-04-30 — AETHER α-init bug regression coverage.
// When the decomposer (or any caller) hands a task model that does not
// match the executor_hint's CLI provider family, the executor used to pass
// the foreign model to the CLI's `--model` flag, which would error out
// with "Unknown model" 12-15s later, classify as `unknown`, and retry the
// SAME broken combo until budget exhaustion.
//
// The fix: detect mismatch in resolveCliSpec and DROP the model arg so the
// CLI uses its native default. The mismatch is logged to stderr but the
// task still runs — graceful degradation instead of cascading failure.
describe('resolveCliSpec — model↔CLI compatibility (AETHER α-init regression)', () => {
  it('cli:codex + cc/* model → drops --model (Codex would not recognise Claude id)', () => {
    const spec = resolveCliSpec('cli:codex', taskWithModel('cc/claude-sonnet-4-6'));
    // --model dropped (incompatible) but --yolo stays (write permission)
    expect(spec.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config']);
  });

  it('cli:codex + cx/* model → keeps --model (matches Codex provider family)', () => {
    const spec = resolveCliSpec('cli:codex', taskWithModel('cx/gpt-5.4'));
    expect(spec.args).toEqual(['exec', '--model', 'gpt-5.4', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config']);
  });

  it('cli:gemini + cc/* model → incompatível vira o --model default do agy (agy não reconhece id Claude)', () => {
    const spec = resolveCliSpec('cli:gemini', taskWithModel('cc/claude-sonnet-4-6'));
    // cliModel incompatível é dropado; o adapter agy sempre passa --model
    // (default gemini-3.1-pro). -p segue por último (prompt como arg).
    expect(spec.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '-p']);
  });

  it('cli:gemini + gemini-cli/* model → ids *-preview do gemini-cli morto normalizam para o default do agy', () => {
    const spec = resolveCliSpec('cli:gemini', taskWithModel('gemini-cli/gemini-3.1-pro-preview'));
    // 'gemini-3.1-pro-preview' não é um id do agy — o adapter normaliza
    // qualquer /preview/i para o default verificado.
    expect(spec.args).toEqual(['--dangerously-skip-permissions', '--model', 'gemini-3.1-pro', '-p']);
  });

  // Note: `cli:claude-code` (and `cli:auto` / `cli:default`) is intentionally
  // treated as "use the model's natural CLI" — i.e. cli:claude-code + cx/*
  // resolves to cli:codex via inferCliIdFromTask, which then keeps the model.
  // This is auto-routing, not the bug we're guarding against. The bug was
  // EXPLICIT cli:codex + cc/* — the explicit case is what must drop the model.
  it('cli:claude-code + cc/* model → keeps --model (claude bin + claude model)', () => {
    const spec = resolveCliSpec('cli:claude-code', taskWithModel('cc/claude-sonnet-4-6'));
    expect(spec.args).toContain('--model');
    expect(spec.args).toContain('claude-sonnet-4-6');
  });

  it('cli:kimi + cc/* model → drops --model (Kimi would not recognise Claude id)', () => {
    const spec = resolveCliSpec('cli:kimi', taskWithModel('cc/claude-sonnet-4-6'));
    // Kimi spec has no --model arg form anyway, but the compatibility check
    // should still set cliModel to null so any future Kimi impl that adds
    // --model honours the drop.
    expect(spec.args).not.toContain('--model');
    expect(spec.args).not.toContain('claude-sonnet-4-6');
  });

  it('cli:opencode + foreign cc/* model → drops -m (OpenCode has no `cc` provider)', () => {
    const spec = resolveCliSpec('cli:opencode', taskWithModel('cc/claude-sonnet-4-6'));
    expect(spec.args).not.toContain('-m');
    expect(spec.args).not.toContain('cc/claude-sonnet-4-6');
  });

  it('null model → no --model flag regardless of CLI (but --dangerously-bypass-approvals-and-sandbox stays for codex)', () => {
    const spec = resolveCliSpec('cli:codex', taskWithModel(null));
    expect(spec.args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config']);
  });
});
