// Sprint T5 (2026-07-04) — ITEM 1: decomposer retry on unparseable output.
// ITEM 2: surface non-fatal DAG validation warnings ('decomposer_warnings').
//
// Pre-fix, decompose() only re-tried when the first error message contained
// 'failed validation' (validator rejection). When the model returned prose or
// truncated JSON, parseDecomposerOutput threw a parse/schema error that
// bypassed the retry and surfaced raw to the operator. These tests pin the
// broadened guard:
//   1. prose → valid JSON on retry ⇒ decompose resolves with the retry DAG,
//      and the retry prompt instructs "JSON only, no markdown".
//   2. non-parse errors (e.g. network) still propagate WITHOUT a retry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal DAG that passes DagSchema + validateDag (same shape used by
// tests/unit/decomposer-variant.test.ts — hitl plan gate + one dependent task
// with falsifiable acceptance criteria).
const VALID_DAG_JSON = JSON.stringify({
  tasks: [
    {
      id: 't0',
      name: 'Review plan',
      kind: 'llm_call',
      depends_on: [],
      executor_hint: null,
      acceptance_criteria: 'Plan enumerates the task below and confirms exit code equals 0',
      hitl: true,
    },
    {
      id: 't1',
      name: 'Task one',
      kind: 'llm_call',
      depends_on: ['t0'],
      executor_hint: null,
      acceptance_criteria: 'Returns a result with exit code equals 0 and non-empty content',
      model: 'cc/claude-sonnet-4-6',
    },
  ],
});

const PROSE_OUTPUT =
  'Sure! Here is my plan: first I would review the objective, then I would ' +
  'split it into a couple of tasks. Let me know if you want the JSON version.';

describe('decomposer — retry on unparseable JSON output (T5 ITEM 1)', () => {
  let originalPersonas: string | undefined;

  beforeEach(() => {
    // Force the legacy path — the persona path has its own retry semantics
    // and would never reach the guard under test.
    originalPersonas = process.env.OMNIFORGE_USE_PERSONAS;
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
  });

  afterEach(() => {
    if (originalPersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalPersonas;
    vi.restoreAllMocks();
  });

  it('retries once when the first output is prose and resolves with the retry DAG', async () => {
    const callMod = await import('../../src/utils/omniroute-call.js');
    const userPrompts: string[] = [];
    const fakeCall = vi
      .spyOn(callMod, 'callOmnirouteWithUsage')
      .mockImplementation(async (input) => {
        userPrompts.push(input.userPrompt);
        const content = userPrompts.length === 1 ? PROSE_OUTPUT : VALID_DAG_JSON;
        return {
          content,
          usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0 },
          model_used: 'cc/claude-sonnet-4-6',
        };
      });

    const { decompose } = await import('../../src/brain/decomposer.js');
    const dag = await decompose('Parse-retry smoke test objective');

    expect(fakeCall).toHaveBeenCalledTimes(2);
    expect(dag.tasks).toHaveLength(2);
    expect(dag.tasks.map((t) => t.id)).toEqual(['t0', 't1']);

    // The retry prompt must instruct: previous output was not valid JSON;
    // re-emit ONLY the JSON object, no markdown.
    const retryPrompt = userPrompts[1]!;
    expect(retryPrompt).toContain('was not valid JSON');
    expect(retryPrompt).toContain('Re-emit ONLY the JSON object');
    expect(retryPrompt).toContain('no markdown');
  });

  it('retries once when the first output is valid JSON that misses DagSchema', async () => {
    const callMod = await import('../../src/utils/omniroute-call.js');
    let calls = 0;
    const fakeCall = vi
      .spyOn(callMod, 'callOmnirouteWithUsage')
      .mockImplementation(async () => {
        calls += 1;
        return {
          content: calls === 1 ? JSON.stringify({ steps: ['not a dag'] }) : VALID_DAG_JSON,
          usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0 },
          model_used: 'cc/claude-sonnet-4-6',
        };
      });

    const { decompose } = await import('../../src/brain/decomposer.js');
    const dag = await decompose('Schema-retry smoke test objective');

    expect(fakeCall).toHaveBeenCalledTimes(2);
    expect(dag.tasks).toHaveLength(2);
  });

  it('does NOT retry on non-parse errors (e.g. network) — error propagates as-is', async () => {
    const callMod = await import('../../src/utils/omniroute-call.js');
    const fakeCall = vi
      .spyOn(callMod, 'callOmnirouteWithUsage')
      .mockRejectedValue(new Error('ECONNREFUSED: Omniroute unreachable'));

    const { decompose } = await import('../../src/brain/decomposer.js');
    await expect(decompose('Network-failure regression objective')).rejects.toThrow(
      'ECONNREFUSED: Omniroute unreachable',
    );
    expect(fakeCall).toHaveBeenCalledTimes(1);
  });

  it('throws the aggregated error when both attempts are unparseable (still only 1 retry)', async () => {
    const callMod = await import('../../src/utils/omniroute-call.js');
    const fakeCall = vi
      .spyOn(callMod, 'callOmnirouteWithUsage')
      .mockResolvedValue({
        content: PROSE_OUTPUT,
        usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0 },
        model_used: 'cc/claude-sonnet-4-6',
      });

    const { decompose } = await import('../../src/brain/decomposer.js');
    await expect(decompose('Double-parse-failure objective')).rejects.toThrow(/twice/);
    expect(fakeCall).toHaveBeenCalledTimes(2);
  });
});

// ─── ITEM 2 — DAG validation warnings surfaced as events ────────────────────

// DAG that passes validation but trips the 'cli-spawn-timeout' warn rule:
// a cli_spawn task without timeout_seconds.
const DAG_WITH_WARNING_JSON = JSON.stringify({
  tasks: [
    {
      id: 't0',
      name: 'Review plan',
      kind: 'llm_call',
      depends_on: [],
      executor_hint: null,
      acceptance_criteria: 'Plan enumerates the task below and confirms exit code equals 0',
      hitl: true,
    },
    {
      id: 't1',
      name: 'Implement feature via CLI',
      kind: 'cli_spawn',
      depends_on: ['t0'],
      executor_hint: 'cli:claude-code',
      acceptance_criteria: 'File src/App.tsx exists with the implementation and exit code equals 0',
    },
  ],
});

describe('decomposer — validation warnings surfaced (T5 ITEM 2)', () => {
  let originalPersonas: string | undefined;

  beforeEach(() => {
    originalPersonas = process.env.OMNIFORGE_USE_PERSONAS;
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
  });

  afterEach(() => {
    if (originalPersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalPersonas;
    vi.restoreAllMocks();
  });

  function mockCallReturning(content: string): Promise<typeof import('../../src/utils/omniroute-call.js')> {
    return import('../../src/utils/omniroute-call.js').then((callMod) => {
      vi.spyOn(callMod, 'callOmnirouteWithUsage').mockResolvedValue({
        content,
        usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0 },
        model_used: 'cc/claude-sonnet-4-6',
      });
      return callMod;
    });
  }

  it('emits an aggregated console.warn when the DAG passes with warnings (no db)', async () => {
    await mockCallReturning(DAG_WITH_WARNING_JSON);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { decompose } = await import('../../src/brain/decomposer.js');
    const dag = await decompose('Warnings surface smoke test');
    expect(dag.tasks).toHaveLength(2);

    const aggregated = warnSpy.mock.calls
      .map((args) => args.map(String).join(' '))
      .find((line) => line.includes('DAG accepted with'));
    expect(aggregated).toBeDefined();
    expect(aggregated).toContain('validation warning(s)');
    expect(aggregated).toContain('[cli-spawn-timeout]');
  });

  it('persists a decomposer_warnings event when options.db + workflowId are provided', async () => {
    const { initDb } = await import('../../src/db/client.js');
    const { getDbPath } = await import('../../src/utils/config.js');
    const { insertWorkflowWithTasks, newWorkflowId, newTaskId } = await import(
      '../../src/db/persist.js'
    );

    const db = initDb(getDbPath());
    const wfId = newWorkflowId();
    const now = Date.now();
    insertWorkflowWithTasks(
      db,
      {
        id: wfId,
        workspace: 'retry_parse_warnings_test',
        objective: 'warnings event test',
        pattern_id: null,
        status: 'executing',
        started_at: now,
        completed_at: null,
        created_at: now,
        created_by: 'retry_parse_test',
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
      },
      [
        {
          id: newTaskId(),
          workflow_id: wfId,
          name: 'noop',
          kind: 'llm_call',
          input_json: '{}',
          output_json: null,
          status: 'pending',
          depends_on: [],
          executor_hint: null,
          timeout_seconds: 60,
          max_retries: 1,
          retry_count: 0,
          retry_policy: 'exponential',
          started_at: null,
          completed_at: null,
          created_at: now,
          acceptance_criteria: 'exit code equals 0',
          refine_count: 0,
          max_refine: 1,
          refine_feedback: null,
          model: null,
          hitl: false,
          execution_mode: 'ephemeral',
        },
      ],
    );

    try {
      await mockCallReturning(DAG_WITH_WARNING_JSON);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { decompose } = await import('../../src/brain/decomposer.js');
      await decompose('Warnings event smoke test', {
        db,
        workflowId: wfId,
        workspace: 'retry_parse_warnings_test',
      });

      const event = db
        .prepare(
          `SELECT type, payload_json FROM events
            WHERE workflow_id = ? AND type = 'decomposer_warnings'`,
        )
        .get(wfId) as { type: string; payload_json: string } | undefined;
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.payload_json) as {
        warning_count: number;
        warnings: Array<{ rule: string; message: string }>;
      };
      expect(payload.warning_count).toBeGreaterThanOrEqual(1);
      expect(payload.warnings.some((w) => w.rule === 'cli-spawn-timeout')).toBe(true);
    } finally {
      db.prepare('DELETE FROM events WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
      db.close();
    }
  });
});
