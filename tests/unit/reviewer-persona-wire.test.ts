import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Task } from '../../src/types/index.js';
import type { ReviewerOutput } from '../../src/v2/agents/index.js';

const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));

vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

const { reviewTask } = await import('../../src/reviewer/reviewer.js');
const { buildReviewerInputFromTask } = await import('../../src/v2/reviewer/outcome.js');
const { createInMemoryContext, REVIEWER_PERSONA, runAgent } = await import('../../src/v2/agents/index.js');

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    workflow_id: 'wf_1',
    name: 'Review me',
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'completed',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: 'Answer contains ok.',
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
    workspace: process.cwd(),
    ...overrides,
  };
}

function reviewerOutput(overrides: Partial<ReviewerOutput> = {}): ReviewerOutput {
  return {
    verdict: 'pass',
    feedback: 'accepted',
    evidence: [{ criterion: 'Answer contains ok.', status: 'met', proof: 'output contains ok' }],
    filesystem_check_summary: { files_verified: [], files_missing: [], files_too_short: [] },
    llm_called: true,
    ...overrides,
  };
}

describe('reviewer persona wire', () => {
  const previousFlag = process.env.OMNIFORGE_USE_PERSONAS;

  beforeEach(() => {
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = previousFlag;
  });

  it('keeps the legacy reviewer path when OMNIFORGE_USE_PERSONAS is false', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    omnirouteMock.callOmniroute.mockResolvedValue(
      JSON.stringify({ outcome_type: 'hard_success', confidence: 0.91, feedback: 'legacy pass' }),
    );

    const result = await reviewTask(baseTask(), 'ok');

    expect(result).toEqual({ score: 1, feedback: 'legacy pass', passed: true });
    expect(omnirouteMock.callOmniroute).toHaveBeenCalledTimes(1);
    expect(omnirouteMock.callOmnirouteWithUsage).not.toHaveBeenCalled();
  });

  it('uses REVIEWER_PERSONA when OMNIFORGE_USE_PERSONAS is true', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'true';
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: JSON.stringify(reviewerOutput()),
      model_used: 'cc/claude-sonnet-4-6',
    });

    const result = await reviewTask(baseTask(), 'ok');

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.feedback).toContain('accepted');
    expect(omnirouteMock.callOmnirouteWithUsage).toHaveBeenCalledTimes(1);
    expect(omnirouteMock.callOmniroute).not.toHaveBeenCalled();
  });

  it('maps persona soft_fail to soft_success so reviewer errors do not block clusters', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'true';
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: JSON.stringify(reviewerOutput({
        verdict: 'soft_fail',
        feedback: 'reviewer technical issue',
        evidence: [{ criterion: 'Answer contains ok.', status: 'ambiguous', proof: 'reviewer timed out' }],
        filesystem_check_summary: {
          files_verified: ['src/ok.ts'],
          files_missing: ['src/missing.ts'],
          files_too_short: [],
        },
      })),
      model_used: 'cc/claude-sonnet-4-6',
    });

    const result = await reviewTask(baseTask(), 'ok');

    expect(result).toEqual({
      score: 0.8,
      feedback: expect.stringContaining('reviewer technical issue'),
      passed: true,
    });
    expect(result.feedback).toContain('Evidence:');
    expect(result.feedback).toContain('Filesystem:');
  });

  it('populates ReviewerInput with cli files and tool trace from worker output_json', () => {
    const input = buildReviewerInputFromTask(
      baseTask({ kind: 'cli_spawn', workspace: 'C:/repo' }),
      JSON.stringify({
        result_text: 'Wrote README.md.',
        files_written: ['README.md'],
        tool_calls: [{ name: 'Write', args_summary: 'README.md' }],
      }),
      { workspaceDir: 'C:/repo' },
    );

    expect(input).toMatchObject({
      task_id: 'task_1',
      workflow_id: 'wf_1',
      task_kind: 'cli_spawn',
      files_claimed_written: ['README.md'],
      tool_calls_trace: [{ name: 'Write', args_summary: 'README.md' }],
    });
  });

  it('populates ReviewerInput with tool trace from CLI_TOOL_CALLS text envelopes', () => {
    const input = buildReviewerInputFromTask(
      baseTask({ kind: 'cli_spawn', workspace: 'C:/repo' }),
      [
        '[[CLI_TOOL_CALLS]]',
        '- ToolSearch (query)',
        '- Write (file_path,content)',
        '- Bash (command,description,timeout)',
        '[[CLI_RESULT]]',
        'Scaffold complete. Files were written to OUTPUT_DIR.',
      ].join('\n'),
      { workspaceDir: 'C:/repo' },
    );

    expect(input.tool_calls_trace).toEqual([
      { name: 'ToolSearch', args_summary: 'query' },
      { name: 'Write', args_summary: 'file_path,content' },
      { name: 'Bash', args_summary: 'command,description,timeout' },
    ]);
  });

  it('extracts markdown-linked filesystem artifacts from narrative CLI output', () => {
    const input = buildReviewerInputFromTask(
      baseTask({ kind: 'cli_spawn', workspace: 'C:/repo' }),
      'Report written to [t1-codebase-entrypoints-report.md](C:/repo/run%20output/t1-codebase-entrypoints-report.md).',
      { workspaceDir: 'C:/repo/run output' },
    );

    expect(input.files_claimed_written).toEqual([
      'C:/repo/run output/t1-codebase-entrypoints-report.md',
    ]);
  });

  it('normalizes Codex App absolute markdown file links with line suffixes', () => {
    const input = buildReviewerInputFromTask(
      baseTask({ kind: 'cli_spawn', workspace: 'C:/repo' }),
      'Updated [src/main.tsx](/C:/Users/Example%20User/project/src/main.tsx:1) and [src/task-create.ts](/C:/Users/Example%20User/project/src/task-create.ts:42).',
      { workspaceDir: 'C:/Users/Example User/project' },
    );

    expect(input.files_claimed_written).toEqual([
      'C:/Users/Example User/project/src/main.tsx',
      'C:/Users/Example User/project/src/task-create.ts',
    ]);
  });

  it('uses worker-linked artifact paths as precomputed filesystem evidence', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'omniforge-reviewer-linked-'));
    try {
      const report = path.join(ws, 't1-codebase-entrypoints-report.md');
      writeFileSync(
        report,
        [
          '# Codebase entrypoints report',
          '## src file tree',
          '- src/main.tsx',
          '- src/App.tsx',
          '## Entry point',
          'src/main.tsx mounts React into #root.',
          '## Task model files',
          'src/types/task.ts and src/stores/taskStore.ts.',
          '## Rendering layer',
          'React + TypeScript + Vite.',
          '## CSS conventions',
          'Tailwind utility classes plus semantic surface-panel classes.',
        ].join('\n'),
        'utf-8',
      );

      let capturedPrompt = '';
      const out = await runAgent(
        REVIEWER_PERSONA,
        {
          task_id: 'task_1',
          workflow_id: 'wf_1',
          task_kind: 'cli_spawn',
          acceptance_criteria:
            'Output is a markdown report containing src/ file tree, main entry point path, task model/type/interface file paths, rendering/DOM layer identification, and CSS class naming conventions. Report is ≥200 characters.',
          worker_output: `Report written to [t1-codebase-entrypoints-report.md](${report.replace(/\\/g, '/').replace(/ /g, '%20')}).`,
          workspace_dir: ws,
          files_claimed_written: [report],
          tool_calls_trace: [],
        },
        createInMemoryContext(),
        {
          parseJson: true,
          invoke: async ({ systemPrompt }) => {
            capturedPrompt = systemPrompt;
            return JSON.stringify(reviewerOutput({
              evidence: [
                {
                  criterion: 'markdown report artifact',
                  status: 'met',
                  proof: 'Precomputed filesystem check verified t1-codebase-entrypoints-report.md exists.',
                },
              ],
              filesystem_check_summary: {
                files_verified: ['t1-codebase-entrypoints-report.md'],
                files_missing: [],
                files_too_short: [],
              },
            }));
          },
        },
      );

      expect(out.verdict).toBe('pass');
      expect(capturedPrompt).toContain('t1-codebase-entrypoints-report.md');
      expect(capturedPrompt).toMatch(/"files_verified"\s*:\s*\[\s*"t1-codebase-entrypoints-report\.md"\s*\]/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('tells the reviewer not to require Write/Edit evidence for LLM-only text deliverables', () => {
    expect(REVIEWER_PERSONA.hardRules.join('\n')).toContain(
      'For llm_call text deliverables',
    );
  });

  it('passes precomputed filesystem evidence to the LLM reviewer when semantic checks are needed', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'omniforge-reviewer-wire-'));
    try {
      const target = path.join(ws, 'src/data/mock.ts');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        [
          'export const mockWorkspace = { id: "ws_1" };',
          'export const mockProjects = [{ id: "prj_1" }];',
          'export const mockTasks = [{ id: "task_1" }];',
          'export const mockUsers = [{ id: "user_1" }];',
          'export const mockTimeEntries = [{ id: "time_1" }];',
          'export const mockComments = [{ id: "comment_1" }];',
        ].join('\n'),
        'utf-8',
      );

      let capturedPrompt = '';
      const out = await runAgent(
        REVIEWER_PERSONA,
        {
          task_id: 'task_1',
          workflow_id: 'wf_1',
          task_kind: 'cli_spawn',
          acceptance_criteria:
            'src/data/mock.ts exports mockWorkspace, mockProjects, mockTasks, mockUsers, mockTimeEntries, mockComments.',
          worker_output: 'Created comprehensive mock data in src/data/mock.ts.',
          workspace_dir: ws,
          tool_calls_trace: [],
        },
        createInMemoryContext(),
        {
          parseJson: true,
          invoke: async ({ systemPrompt }) => {
            capturedPrompt = systemPrompt;
            return JSON.stringify(reviewerOutput({
              evidence: [
                {
                  criterion: 'src/data/mock.ts exports mock data constants',
                  status: 'met',
                  proof: 'Precomputed filesystem check verified src/data/mock.ts exists.',
                },
              ],
              filesystem_check_summary: {
                files_verified: ['src/data/mock.ts'],
                files_missing: [],
                files_too_short: [],
              },
            }));
          },
        },
      );

      expect(out.verdict).toBe('pass');
      expect(capturedPrompt).toContain('Precomputed filesystem check');
      expect(capturedPrompt).toContain('src/data/mock.ts');
      expect(capturedPrompt).toContain('files_verified');
      expect(capturedPrompt).toContain('Do not fail solely because the CLI trace has no Write/Edit');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('soft-fails trace-only reviewer failures when precomputed filesystem evidence is clean', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'omniforge-reviewer-soften-'));
    try {
      const target = path.join(ws, 'src/data/mock.ts');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        [
          'export const mockWorkspace = { id: "ws_1" };',
          'export const mockProjects = [{ id: "prj_1" }];',
          'export const mockTasks = [{ id: "task_1" }];',
          'export const mockUsers = [{ id: "user_1" }];',
          'export const mockTimeEntries = [{ id: "time_1" }];',
          'export const mockComments = [{ id: "comment_1" }];',
        ].join('\n'),
        'utf-8',
      );

      const out = await runAgent(
        REVIEWER_PERSONA,
        {
          task_id: 'task_1',
          workflow_id: 'wf_1',
          task_kind: 'cli_spawn',
          acceptance_criteria:
            'src/data/mock.ts exports mockWorkspace, mockProjects, mockTasks, mockUsers, mockTimeEntries, mockComments.',
          worker_output: 'Created comprehensive mock data in src/data/mock.ts.',
          workspace_dir: ws,
          tool_calls_trace: [],
        },
        createInMemoryContext(),
        {
          parseJson: true,
          invoke: async () => JSON.stringify(reviewerOutput({
            verdict: 'fail',
            feedback:
              'Tool-call trace is empty. There are no Write/Edit operations, so without filesystem corroboration the narrative cannot be trusted.',
            evidence: [],
            filesystem_check_summary: {
              files_verified: ['src/data/mock.ts'],
              files_missing: [],
              files_too_short: [],
            },
          })),
        },
      );

      expect(out.verdict).toBe('soft_fail');
      expect(out.feedback).toContain('Reviewer technical soft-fail');
      expect(out.filesystem_check_summary.files_verified).toContain('src/data/mock.ts');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
