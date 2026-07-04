import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import type { Dag, Task, Workflow } from '../../src/types/index.js';

// Mock artifact store so integration tests control upstream content without filesystem
vi.mock('../../src/artifacts/store.js', () => ({
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  loadArtifactsForTask: vi.fn().mockResolvedValue([]),
  loadArtifactContent: vi.fn().mockResolvedValue(''),
  loadArtifactsForWorkflow: vi.fn().mockResolvedValue([]),
}));

// Mock omniroute-call (may be imported transitively)
vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('summary'),
}));

import { applySelector } from '../../src/v2/contracts/apply-selectors.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import { loadArtifactsForTask, loadArtifactContent } from '../../src/artifacts/store.js';

const mockLoadArtifactsForTask = vi.mocked(loadArtifactsForTask);
const mockLoadArtifactContent = vi.mocked(loadArtifactContent);

interface EventRow { type: string; payload_json: string | null }

function eventTypes(db: Database.Database, wfId: string): string[] {
  return (db
    .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
    .all(wfId) as { type: string }[]).map(r => r.type);
}

function payloadsOfType(db: Database.Database, wfId: string, type: string): unknown[] {
  return (db
    .prepare('SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id')
    .all(wfId, type) as EventRow[]).map(r => r.payload_json ? JSON.parse(r.payload_json) : null);
}

// ---------------------------------------------------------------------------
// applySelector — unit tests (pure function, no DB)
// ---------------------------------------------------------------------------

describe('applySelector', () => {
  it('raw_full returns content unchanged with equal token counts', () => {
    const content = 'hello world';
    const { sliced, tokensBefore, tokensAfter } = applySelector(content, 'raw_full');
    expect(sliced).toBe(content);
    expect(tokensBefore).toBe(tokensAfter);
  });

  it('summary_only returns first paragraph when shorter than 500 chars', () => {
    const content = 'First para.\n\nSecond para.';
    const { sliced } = applySelector(content, 'summary_only');
    expect(sliced).toBe('First para.');
  });

  it('summary_only truncates at 500 chars when first paragraph is long', () => {
    const long = 'x'.repeat(600);
    const { sliced } = applySelector(long, 'summary_only');
    expect(sliced.length).toBe(500);
  });

  it('summary_only tokensAfter <= tokensBefore for long content', () => {
    const content = 'word '.repeat(300);
    const { tokensBefore, tokensAfter } = applySelector(content, 'summary_only');
    expect(tokensAfter).toBeLessThanOrEqual(tokensBefore);
  });

  it('string[] picks declared fields from JSON', () => {
    const content = JSON.stringify({ field1: 'v1', field2: 'v2', field3: 'v3' });
    const { sliced } = applySelector(content, ['field1', 'field3']);
    const parsed = JSON.parse(sliced) as Record<string, unknown>;
    expect(parsed['field1']).toBe('v1');
    expect(parsed['field3']).toBe('v3');
    expect('field2' in parsed).toBe(false);
  });

  it('string[] returns smaller or equal token count than original', () => {
    const content = JSON.stringify({ keep: 'val', drop: 'x'.repeat(1000) });
    const { tokensBefore, tokensAfter } = applySelector(content, ['keep']);
    expect(tokensAfter).toBeLessThan(tokensBefore);
  });

  it('string[] with missing fields returns empty object', () => {
    const content = JSON.stringify({ a: 1 });
    const { sliced } = applySelector(content, ['nonexistent']);
    expect(JSON.parse(sliced)).toEqual({});
  });

  it('string[] falls back to raw content when artifact is not JSON', () => {
    const content = 'plain text, not JSON';
    const { sliced } = applySelector(content, ['field1']);
    expect(sliced).toBe(content);
  });

  it('tokensBefore reflects original content tokens', () => {
    const content = 'a'.repeat(380); // ~100 tokens at 3.8 ratio
    const { tokensBefore } = applySelector(content, 'raw_full');
    expect(tokensBefore).toBeGreaterThan(90);
  });
});

// ---------------------------------------------------------------------------
// DagTaskSchema — input_selectors validation
// ---------------------------------------------------------------------------

describe('DagTaskSchema — input_selectors', () => {
  it('accepts task with input_selectors string[] value', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const dag = {
      tasks: [{
        id: 't1', name: 'x', kind: 'llm_call', depends_on: [],
        input_selectors: { 'upstream-id': ['field1', 'field2'] },
      }],
    };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });

  it('accepts task with input_selectors summary_only', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const dag = {
      tasks: [{
        id: 't1', name: 'x', kind: 'llm_call', depends_on: [],
        input_selectors: { 'task-a': 'summary_only' },
      }],
    };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });

  it('accepts task with output_summary string', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const dag = {
      tasks: [{
        id: 't1', name: 'x', kind: 'llm_call', depends_on: [],
        output_summary: 'produces JSON with field1 and field2',
      }],
    };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });

  it('accepts task without input_selectors (V1 compat)', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const dag = {
      tasks: [{ id: 't1', name: 'x', kind: 'llm_call', depends_on: [] }],
    };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executor integration — V1 compat (no selectors)
// ---------------------------------------------------------------------------

describe('executor — V1 compat (no selectors)', () => {
  beforeEach(() => {
    mockLoadArtifactsForTask.mockResolvedValue([]);
    mockLoadArtifactContent.mockResolvedValue('');
  });

  it('task without input_selectors produces no task_input_sliced event', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'producer', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 't2', name: 'consumer', kind: 'llm_call', depends_on: ['t1'], executor_hint: null, model: null },
      ],
    };

    let calls = 0;
    const executeFn = async (): Promise<string> => {
      calls += 1;
      return `output-${calls}`;
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });

    const types = eventTypes(db, wf.id);
    expect(types).not.toContain('task_input_sliced');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// executor integration — selector slicing
// ---------------------------------------------------------------------------

describe('executor — input_selectors slicing', () => {
  const jsonArtifact = JSON.stringify({ field1: 'important-value', field2: 'drop-me-big-data-here' });

  beforeEach(() => {
    // Producer has depends_on:[], so loadArtifactsForTask is never called for it.
    // All calls come from the consumer's upstream lookup.
    mockLoadArtifactsForTask.mockResolvedValue([
      { id: 'art-1', task_id: 'upstream', content_inline: jsonArtifact, content_path: null } as never,
    ]);
    mockLoadArtifactContent.mockImplementation(async (art: { content_inline: string | null }) =>
      art.content_inline ?? '',
    );
  });

  it('task with string[] selector receives only declared fields + emits task_input_sliced', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'prod', name: 'producer', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        {
          id: 'cons', name: 'consumer', kind: 'llm_call', depends_on: ['prod'],
          executor_hint: null, model: null,
          input_selectors: { prod: ['field1'] },
        },
      ],
    };

    let consumerInput: string | null = null;
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx += 1;
      if (t.name === 'consumer') {
        consumerInput = t.input_json;
      }
      return `out-${callIdx}`;
    };

    await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const types = eventTypes(db, wfRow.id);
    expect(types).toContain('task_input_sliced');

    // Consumer upstream_artifacts should only have field1, not field2
    if (consumerInput) {
      const ctx = JSON.parse(consumerInput) as Record<string, unknown>;
      const upstream = ctx['upstream_artifacts'] as string | undefined;
      if (upstream) {
        expect(upstream).toContain('field1');
        expect(upstream).not.toContain('drop-me-big-data-here');
      }
    }

    // task_input_sliced payload has selector info and token counts
    const slicedPayloads = payloadsOfType(db, wfRow.id, 'task_input_sliced') as Array<{
      upstream_task_id: string;
      selector: unknown;
      tokensBefore: number;
      tokensAfter: number;
    }>;
    expect(slicedPayloads.length).toBeGreaterThanOrEqual(1);
    expect(slicedPayloads[0]?.tokensBefore).toBeGreaterThan(0);
    expect(slicedPayloads[0]?.tokensAfter).toBeGreaterThan(0);
    expect(slicedPayloads[0]?.tokensAfter).toBeLessThan(slicedPayloads[0]!.tokensBefore);

    db.close();
  });

  it('task with summary_only selector receives truncated content + emits task_input_sliced', async () => {
    // Override mock for this test
    mockLoadArtifactsForTask.mockResolvedValue([
      { id: 'art-2', task_id: 'upstream', content_inline: 'First para.\n\nSecond para with more detail.', content_path: null } as never,
    ]);

    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'prod', name: 'producer', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        {
          id: 'cons', name: 'consumer', kind: 'llm_call', depends_on: ['prod'],
          executor_hint: null, model: null,
          input_selectors: { prod: 'summary_only' },
        },
      ],
    };

    let consumerInput: string | null = null;
    const executeFn = async (t: Task): Promise<string> => {
      if (t.name === 'consumer') consumerInput = t.input_json;
      return 'ok';
    };

    await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
    });

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const types = eventTypes(db, wfRow.id);
    expect(types).toContain('task_input_sliced');

    if (consumerInput) {
      const ctx = JSON.parse(consumerInput) as Record<string, unknown>;
      const upstream = ctx['upstream_artifacts'] as string | undefined;
      // Only first paragraph
      if (upstream) {
        expect(upstream).toContain('First para.');
        expect(upstream).not.toContain('Second para with more detail.');
      }
    }

    db.close();
  });
});
