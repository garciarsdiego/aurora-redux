/**
 * Worker.cli_spawn persona regression tests.
 *
 * The headline failure mode is `worker.described_without_writing` — the bug
 * we hit on 2026-05-04 where the CLI worker reads a stale stub, declares
 * "files already exist", and never calls Write. The first test in this file
 * is the regression check the RFC demands.
 *
 * Other tests cover the file-existence + content sanity checks the postHook
 * runs against the workspace, plus the workspace-clean preHook behavior.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  WORKER_CLI_SPAWN_PERSONA,
  WORKER_CLI_SPAWN_PREFIX,
  AgentRejectedError,
  createInMemoryContext,
  hasWriteTool,
  isWriteTool,
  requiresWrite,
  extractFilePathsFromAcceptance,
  runAgent,
  type WorkerCliSpawnInput,
} from '../../src/v2/agents/index.js';
import { verifyAcceptanceArtifacts } from '../../src/v2/agents/validators/filesystem.js';

function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omniforge-agents-test-'));
  return dir;
}

function makeInput(overrides: Partial<WorkerCliSpawnInput> = {}): WorkerCliSpawnInput {
  return {
    task_id: 't_test',
    workflow_id: 'wf_test',
    workspace: 'internal',
    cli: 'cli:claude-code',
    model: 'cc/claude-sonnet-4-6',
    prompt: 'Implement Sidebar.tsx',
    acceptance_criteria: 'File src/components/Sidebar.tsx exists with default export Sidebar and ≥50 lines.',
    workspace_dir: makeWorkspace(),
    retry_count: 0,
    timeout_seconds: 600,
    ...overrides,
  };
}

const COMPLETED_OUTPUT_STR = (filesWritten: string[], toolCalls: { name: string; args_summary?: string }[] = [{ name: 'Write', args_summary: 'src/components/Sidebar.tsx' }]) =>
  JSON.stringify({
    exit_code: 0,
    duration_ms: 1500,
    tool_calls: toolCalls,
    files_written: filesWritten,
    files_modified: [],
    files_read: [],
    result_text: 'Wrote Sidebar.tsx with default export Sidebar.',
    blocked: false,
  });

function fakeInvoker(responses: string[]): { invoke: (args: unknown) => Promise<string>; calls: number } {
  let i = 0;
  return {
    get calls() { return i; },
    async invoke() {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Headline regression: described_without_writing
// ─────────────────────────────────────────────────────────────────────────────

describe('WORKER_CLI_SPAWN_PERSONA — failure mode: described_without_writing', () => {
  it('rejects output with only Read tool calls when acceptance demands write', async () => {
    const input = makeInput();
    const ctx = createInMemoryContext();
    const badOutput = JSON.stringify({
      exit_code: 0,
      duration_ms: 800,
      tool_calls: [
        { name: 'Glob', args_summary: 'src/**/*.tsx' },
        { name: 'Read', args_summary: 'src/components/Sidebar.tsx' },
      ],
      files_written: [],
      files_modified: [],
      files_read: ['src/components/Sidebar.tsx'],
      result_text: 'Both files already exist and satisfy acceptance criteria',
      blocked: false,
    });
    const inv = fakeInvoker([badOutput]);
    await expect(
      runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'worker.described_without_writing',
    });
  });

  it('passes when acceptance demands write AND Write/Edit was called AND file exists', async () => {
    const input = makeInput();
    const targetAbs = path.resolve(input.workspace_dir, 'src/components/Sidebar.tsx');
    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, 'import React from "react";\n\nexport default function Sidebar() { return <aside />; }\n'.repeat(20), 'utf-8');

    const ctx = createInMemoryContext();
    const inv = fakeInvoker([COMPLETED_OUTPUT_STR(['src/components/Sidebar.tsx'])]);
    const output = await runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.exit_code).toBe(0);
    expect(output.files_written).toContain('src/components/Sidebar.tsx');
  });

  it('accepts Edit/str_replace/patch as write-tool aliases', () => {
    expect(isWriteTool('Write')).toBe(true);
    expect(isWriteTool('Edit')).toBe(true);
    expect(isWriteTool('str_replace')).toBe(true);
    expect(isWriteTool('patch')).toBe(true);
    expect(isWriteTool('apply_patch')).toBe(true);
    expect(isWriteTool('Read')).toBe(false);
    expect(isWriteTool('Glob')).toBe(false);
    expect(isWriteTool('Bash')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// File existence + content sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('WORKER_CLI_SPAWN_PERSONA — file_missing', () => {
  it('rejects when claimed file does not exist on disk', async () => {
    const input = makeInput();
    const ctx = createInMemoryContext();
    const inv = fakeInvoker([COMPLETED_OUTPUT_STR(['src/components/Sidebar.tsx'])]);
    await expect(
      runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'worker.file_missing',
    });
  });
});

describe('WORKER_CLI_SPAWN_PERSONA — file_empty', () => {
  it('rejects when claimed file is < 10 chars of content', async () => {
    const input = makeInput();
    const targetAbs = path.resolve(input.workspace_dir, 'src/components/Sidebar.tsx');
    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, '   \n', 'utf-8');

    const ctx = createInMemoryContext();
    const inv = fakeInvoker([COMPLETED_OUTPUT_STR(['src/components/Sidebar.tsx'])]);
    await expect(
      runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'worker.file_empty',
    });
  });
});

describe('WORKER_CLI_SPAWN_PERSONA — markdown_in_code_file', () => {
  it('rejects when .tsx file starts with markdown header', async () => {
    const input = makeInput();
    const targetAbs = path.resolve(input.workspace_dir, 'src/components/Sidebar.tsx');
    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, '# Sidebar Component\n\nThis would render a sidebar.\n'.repeat(5), 'utf-8');

    const ctx = createInMemoryContext();
    const inv = fakeInvoker([COMPLETED_OUTPUT_STR(['src/components/Sidebar.tsx'])]);
    await expect(
      runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'worker.markdown_in_code_file',
    });
  });

  it('does NOT reject when .md file starts with markdown header', async () => {
    const input = makeInput({
      acceptance_criteria: 'File README.md exists and contains a top-level heading.',
    });
    const targetAbs = path.resolve(input.workspace_dir, 'README.md');
    writeFileSync(targetAbs, '# My Project\n\nA description.\n', 'utf-8');

    const ctx = createInMemoryContext();
    const inv = fakeInvoker([
      JSON.stringify({
        exit_code: 0,
        duration_ms: 1000,
        tool_calls: [{ name: 'Write', args_summary: 'README.md' }],
        files_written: ['README.md'],
        files_modified: [],
        files_read: [],
        result_text: 'Wrote README.md.',
        blocked: false,
      }),
    ]);
    const output = await runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.files_written).toContain('README.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// opencode empty output (D-H2.077)
// ─────────────────────────────────────────────────────────────────────────────

describe('WORKER_CLI_SPAWN_PERSONA — opencode_empty_output', () => {
  it('rejects when opencode returns clean exit + empty trace', async () => {
    const input = makeInput({ cli: 'cli:opencode' });
    const ctx = createInMemoryContext();
    const emptyOutput = JSON.stringify({
      exit_code: 0,
      duration_ms: 200,
      tool_calls: [],
      files_written: [],
      files_modified: [],
      files_read: [],
      result_text: '',
      blocked: false,
    });
    const inv = fakeInvoker([emptyOutput]);
    await expect(
      runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'worker.opencode_empty_output',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe('WORKER_CLI_SPAWN_PERSONA — blocked passthrough', () => {
  it('does not reject when output.blocked is true', async () => {
    const input = makeInput();
    const ctx = createInMemoryContext();
    const blockedOutput = JSON.stringify({
      exit_code: 1,
      duration_ms: 5000,
      tool_calls: [],
      files_written: [],
      files_modified: [],
      files_read: [],
      result_text: '<BLOCKED>missing_artifact: t_upstream</BLOCKED>',
      blocked: true,
      blocked_reason: 'missing_artifact: t_upstream',
    });
    const inv = fakeInvoker([blockedOutput]);
    const output = await runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.blocked).toBe(true);
    expect(output.blocked_reason).toContain('missing_artifact');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preHook: prefix + workspace clean
// ─────────────────────────────────────────────────────────────────────────────

describe('WORKER_CLI_SPAWN_PERSONA — preHook prefix injection', () => {
  it('prepends WORKER_CLI_SPAWN_PREFIX to the prompt', async () => {
    const input = makeInput();
    const ctx = createInMemoryContext();
    const targetAbs = path.resolve(input.workspace_dir, 'src/components/Sidebar.tsx');
    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, 'export default function S() { return null; }\n'.repeat(15), 'utf-8');

    let captured = '';
    const invoker = async (args: unknown) => {
      captured = (args as { systemPrompt: string }).systemPrompt;
      return COMPLETED_OUTPUT_STR(['src/components/Sidebar.tsx']);
    };
    await runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: invoker, parseJson: true });
    // The prefix lives inside `INPUT.prompt` which is interpolated into the system prompt template.
    expect(captured).toContain('EXECUTION CONTRACT');
    expect(captured).toContain('Write/Edit tool');
  });

  it('backs up prior-attempt files on retry > 0', async () => {
    const input = makeInput({ retry_count: 1 });
    // Drop a stub at the target location BEFORE invocation
    const targetAbs = path.resolve(input.workspace_dir, 'src/components/Sidebar.tsx');
    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, '// stub from attempt 0\n', 'utf-8');

    const ctx = createInMemoryContext();
    // After backup, the "real" attempt writes a fresh complete file.
    let captured = '';
    const invoker = async (args: unknown) => {
      captured = (args as { systemPrompt: string }).systemPrompt;
      // Simulate the worker writing a full implementation
      writeFileSync(
        targetAbs,
        'import React from "react";\nexport default function Sidebar() { return <aside />; }\n'.repeat(25),
        'utf-8',
      );
      return COMPLETED_OUTPUT_STR(['src/components/Sidebar.tsx']);
    };
    await runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: invoker, parseJson: true });

    // Backup file from attempt 0 should exist
    const backup = `${targetAbs}.attempt_0.bak`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, 'utf-8')).toContain('stub from attempt 0');

    // Workspace clean event was emitted
    expect(ctx.events.find((e) => e.event === 'worker_workspace_clean')).toBeTruthy();

    // Prior-attempts banner present in prompt
    expect(captured).toContain('PRIOR ATTEMPTS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('hasWriteTool detects Write/Edit/str_replace', () => {
    expect(hasWriteTool([{ name: 'Write' }])).toBe(true);
    expect(hasWriteTool([{ name: 'Read' }, { name: 'Edit' }])).toBe(true);
    expect(hasWriteTool([{ name: 'str_replace' }])).toBe(true);
    expect(hasWriteTool([{ name: 'Read' }])).toBe(false);
    expect(hasWriteTool([])).toBe(false);
    expect(hasWriteTool(undefined)).toBe(false);
  });

  it('requiresWrite detects implementation-style acceptance', () => {
    expect(requiresWrite('Implement file src/foo.ts with export default Foo')).toBe(true);
    expect(requiresWrite('Create migration file db/migrations/028.sql')).toBe(true);
    expect(requiresWrite('Update file path src/utils/helper.ts to add export')).toBe(true);
    expect(requiresWrite('File src/index.html exists and contains a canvas')).toBe(true);
    expect(requiresWrite('File src/Sidebar.tsx exists and exports default Sidebar')).toBe(true);
    expect(requiresWrite('Document the design in plain prose')).toBe(false);
    expect(requiresWrite(null)).toBe(false);
  });

  it('extractFilePathsFromAcceptance picks up qualified paths', () => {
    const paths = extractFilePathsFromAcceptance(
      'Files src/components/Sidebar.tsx, src/components/MessageBubble.tsx and src/index.html exist.',
    );
    expect(paths).toContain('src/components/Sidebar.tsx');
    expect(paths).toContain('src/components/MessageBubble.tsx');
    expect(paths).toContain('src/index.html');
  });

  it('verifyAcceptanceArtifacts resolves dot-relative imports against the explicit source file directory', () => {
    const ws = makeWorkspace();
    const srcDir = path.join(ws, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'main.js'), 'import "./engine.js";\n'.repeat(6), 'utf-8');
    writeFileSync(path.join(srcDir, 'engine.js'), 'export function createEngine() {}\n'.repeat(6), 'utf-8');
    writeFileSync(path.join(srcDir, 'input.js'), 'export function bindInput() {}\n'.repeat(6), 'utf-8');
    writeFileSync(path.join(srcDir, 'renderer.js'), 'export function createRenderer() {}\n'.repeat(6), 'utf-8');
    writeFileSync(path.join(srcDir, 'scoring.js'), 'export function createScoring() {}\n'.repeat(6), 'utf-8');

    const out = verifyAcceptanceArtifacts(
      'File src/main.js exists; imports from ./engine.js, ./input.js, ./renderer.js, ./scoring.js.',
      ws,
    );

    expect(out.summary.files_missing).toEqual([]);
    expect(out.summary.files_verified).toEqual(expect.arrayContaining([
      'src/main.js',
      'src/engine.js',
      'src/input.js',
      'src/renderer.js',
      'src/scoring.js',
    ]));
  });

  it('verifyAcceptanceArtifacts accepts short supplemental command-output txt evidence', () => {
    const ws = makeWorkspace();
    const checkOutput = path.join(ws, 'check-output.txt');
    const functionDefinitions = path.join(ws, 'function-definitions.txt');
    writeFileSync(checkOutput, 'ExitCode: 0\n\n> app check\n> tsc --noEmit\n', 'utf-8');
    writeFileSync(
      functionDefinitions,
      [
        'src/stores/task-store.ts:29:export function addTask(title: string): Task {',
        'src/stores/task-store.ts:44:export function deleteTask(id: string): void {',
        'src/stores/task-store.ts:54:export function addSubTask(taskId: string, title: string): SubTask {',
        'src/stores/task-store.ts:71:export function deleteSubTask(taskId: string, subtaskId: string): void {',
      ].join('\n'),
      'utf-8',
    );

    const out = verifyAcceptanceArtifacts(
      'Running the type-check exits with code 0; grep returns exactly 1 match for each task function.',
      ws,
      [checkOutput, functionDefinitions],
    );

    expect(out.verdict).toBe('pass');
    expect(out.summary.files_missing).toEqual([]);
    expect(out.summary.files_too_short).toEqual([]);
    expect(out.summary.files_verified).toEqual(expect.arrayContaining([
      'check-output.txt',
      'function-definitions.txt',
    ]));
  });

  it('WORKER_CLI_SPAWN_PREFIX is non-empty and mentions Write tool', () => {
    expect(WORKER_CLI_SPAWN_PREFIX.length).toBeGreaterThan(100);
    expect(WORKER_CLI_SPAWN_PREFIX).toContain('Write/Edit');
    expect(WORKER_CLI_SPAWN_PREFIX).toContain('<BLOCKED>');
  });
});

describe('AgentRejectedError carries reason + mode + agent id', () => {
  it('includes the failure-mode label so failover classifier can match', async () => {
    const input = makeInput({ cli: 'cli:opencode' });
    const ctx = createInMemoryContext();
    const emptyOutput = JSON.stringify({
      exit_code: 0,
      duration_ms: 100,
      tool_calls: [],
      files_written: [],
      files_modified: [],
      files_read: [],
      result_text: '',
      blocked: false,
    });
    const inv = fakeInvoker([emptyOutput]);
    let caught: AgentRejectedError | null = null;
    try {
      await runAgent(WORKER_CLI_SPAWN_PERSONA, input, ctx, { invoke: inv.invoke, parseJson: true });
    } catch (err) {
      caught = err as AgentRejectedError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.agentId).toBe('worker.cli_spawn');
    expect(caught!.mode).toBe('worker.opencode_empty_output');
  });
});
