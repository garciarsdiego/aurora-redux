import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import type { Dag, Task, Workflow } from '../../src/types/index.js';

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('mocked compact summary'),
}));

import { estimateTokens } from '../../src/v2/context-engine/estimate-tokens.js';
import { truncate7020 } from '../../src/v2/context-engine/truncate.js';
import { DefaultContextEngine } from '../../src/v2/context-engine/default-engine.js';
import { registerContextEngine, resolveContextEngine } from '../../src/v2/context-engine/registry.js';
import type { AgentMessage } from '../../src/v2/context-engine/types.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import { callOmniroute } from '../../src/utils/omniroute-call.js';

const mockCallOmniroute = vi.mocked(callOmniroute);

function makeMessages(count: number, charsEach = 100): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(charsEach),
  } as AgentMessage));
}

interface EventRow { type: string; payload_json: string | null }

function eventTypes(db: Database.Database, wfId: string): string[] {
  const rows = db
    .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
    .all(wfId) as { type: string }[];
  return rows.map(r => r.type);
}

function payloadsOfType(db: Database.Database, wfId: string, type: string): unknown[] {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id')
    .all(wfId, type) as EventRow[];
  return rows.map(r => r.payload_json ? JSON.parse(r.payload_json) : null);
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns non-zero for non-empty messages', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: 'hello world' }];
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });

  it('uses lower char/token ratio for Claude models', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(350) }];
    const claude = estimateTokens(msgs, 'cc/claude-sonnet-4-6');
    const gpt = estimateTokens(msgs, 'cx/gpt-4o');
    // Claude ratio=3.5 yields more tokens than GPT ratio=4.0 for same chars
    expect(claude).toBeGreaterThan(gpt);
  });

  it('applies gemini ratio correctly', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: 'x'.repeat(370) }];
    const gemini = estimateTokens(msgs, 'gemini-pro');
    const def = estimateTokens(msgs, undefined);
    // gemini=3.7, default=3.8 → gemini slightly higher
    expect(gemini).toBeGreaterThanOrEqual(def);
  });

  it('adds per-message overhead', () => {
    const single: AgentMessage[] = [{ role: 'user', content: 'hi' }];
    const two: AgentMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi' },
    ];
    // Two messages should have more token overhead than one
    expect(estimateTokens(two)).toBeGreaterThan(estimateTokens(single));
  });

  it('returns 0+overhead for empty content', () => {
    const msgs: AgentMessage[] = [{ role: 'user', content: '' }];
    expect(estimateTokens(msgs)).toBeGreaterThanOrEqual(4); // per-message overhead
  });
});

// ---------------------------------------------------------------------------
// truncate7020
// ---------------------------------------------------------------------------

describe('truncate7020', () => {
  it('returns original when under budget', () => {
    const msgs = makeMessages(3, 10);
    const result = truncate7020(msgs, 10000);
    expect(result).toEqual(msgs);
  });

  it('inserts truncate marker when over budget', () => {
    const msgs = makeMessages(20, 200);
    const budget = 500;
    const result = truncate7020(msgs, budget);
    const marker = result.find(m => m.id === 'truncate-marker');
    expect(marker).toBeDefined();
    expect(marker?.role).toBe('system');
    expect(marker?.content).toMatch(/truncated/);
  });

  it('marker content shows correct dropped count', () => {
    const msgs = makeMessages(20, 200);
    const result = truncate7020(msgs, 500);
    const marker = result.find(m => m.id === 'truncate-marker')!;
    const keptCount = result.length - 1; // exclude marker
    const droppedCount = msgs.length - keptCount;
    expect(marker.content).toContain(`${droppedCount} messages omitted`);
    expect(marker.content).toContain(`of ${msgs.length} total`);
  });

  it('total tokens of result fit within budget (approximately)', () => {
    const msgs = makeMessages(20, 300);
    const budget = 800;
    const result = truncate7020(msgs, budget);
    const resultTokens = estimateTokens(result);
    // Should be under budget or close (marker adds a few tokens)
    expect(resultTokens).toBeLessThan(budget * 1.2);
  });

  it('result preserves order: head first, then marker, then tail', () => {
    const msgs = makeMessages(10, 300);
    const result = truncate7020(msgs, 500);
    const markerIdx = result.findIndex(m => m.id === 'truncate-marker');
    expect(markerIdx).toBeGreaterThan(0);
    expect(markerIdx).toBeLessThan(result.length - 1);
  });
});

// ---------------------------------------------------------------------------
// DefaultContextEngine
// ---------------------------------------------------------------------------

describe('DefaultContextEngine', () => {
  let engine: DefaultContextEngine;

  beforeEach(() => {
    mockCallOmniroute.mockResolvedValue('test compact summary');
    engine = new DefaultContextEngine();
  });

  it('has info.id = "default" and ownsCompaction = true', () => {
    expect(engine.info.id).toBe('default');
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it('assemble returns messages unchanged when under token budget', async () => {
    const msgs = makeMessages(3, 10);
    const result = await engine.assemble({ messages: msgs, tokenBudget: 10000 });
    expect(result.messages).toEqual(msgs);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('assemble returns messages unchanged when no tokenBudget', async () => {
    const msgs = makeMessages(5, 50);
    const result = await engine.assemble({ messages: msgs });
    expect(result.messages).toEqual(msgs);
  });

  it('assemble truncates when over token budget', async () => {
    const msgs = makeMessages(20, 300);
    const result = await engine.assemble({ messages: msgs, tokenBudget: 500 });
    expect(result.messages.length).toBeLessThan(msgs.length);
    const hasMarker = result.messages.some(m => m.id === 'truncate-marker');
    expect(hasMarker).toBe(true);
  });

  it('compact returns ok:true, compacted:true with summary', async () => {
    const msgs = makeMessages(10, 100);
    const result = await engine.compact({ messages: msgs, force: true });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe('test compact summary');
  });

  it('compact result.firstKeptEntryId is id of first tail message', async () => {
    const msgs = makeMessages(10, 100);
    const splitIdx = Math.floor(msgs.length * 0.7);
    const expectedFirstKept = msgs[splitIdx]?.id;
    const result = await engine.compact({ messages: msgs, force: true });
    expect(result.result?.firstKeptEntryId).toBe(expectedFirstKept);
  });

  it('compact reports tokensBefore and tokensAfter', async () => {
    const msgs = makeMessages(10, 200);
    const result = await engine.compact({ messages: msgs, force: true });
    expect(result.result?.tokensBefore).toBeGreaterThan(0);
    expect(result.result?.tokensAfter).toBeGreaterThan(0);
  });

  it('compact calls callOmniroute with system + user prompts', async () => {
    const msgs = makeMessages(6, 50);
    await engine.compact({ messages: msgs, model: 'cc/claude-haiku-4-5-20251001' });
    expect(mockCallOmniroute).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'cc/claude-haiku-4-5-20251001',
        systemPrompt: expect.stringContaining('Summarize'),
      }),
    );
  });

  it('ingest returns { accepted: true }', async () => {
    const result = await engine.ingest?.({ message: { role: 'user', content: 'hi' } });
    expect(result).toEqual({ accepted: true });
  });
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('resolveContextEngine("default") returns DefaultContextEngine', () => {
    const eng = resolveContextEngine('default');
    expect(eng.info.id).toBe('default');
  });

  it('resolveContextEngine() without arg returns default engine', () => {
    const eng = resolveContextEngine();
    expect(eng.info.id).toBe('default');
  });

  it('registerContextEngine replaces engine with same id', () => {
    const custom = new DefaultContextEngine();
    (custom as unknown as { info: { id: string } }).info = { id: 'custom-test' };
    registerContextEngine(custom);
    expect(resolveContextEngine('custom-test').info.id).toBe('custom-test');
  });

  it('resolveContextEngine throws for unknown id', () => {
    expect(() => resolveContextEngine('nonexistent-xyz')).toThrow('ContextEngine not found');
  });
});

// ---------------------------------------------------------------------------
// executor compaction flow — integration
// ---------------------------------------------------------------------------

describe('executor compaction flow', () => {
  beforeEach(() => {
    mockCallOmniroute.mockResolvedValue('compacted context summary');
  });

  it('context_overflow triggers compaction + retry → success', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'big-task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: 'cc/claude-haiku-4-5-20251001',
        },
      ],
    };

    let calls = 0;
    const executeFn = async (_t: Task): Promise<string> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('Request exceeds maximum context length of 200000 tokens');
      }
      return 'successful output after compaction';
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'test objective', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'consolidated',
      autoApprove: true,
      sleepFn: async () => {},
    });

    const types = eventTypes(db, wf.id);

    expect(types).toContain('task_failover_classified');
    expect(types).toContain('task_needs_compaction');
    expect(types).toContain('context_compacted');
    expect(types).toContain('task_retrying');
    expect(types).toContain('task_completed');

    const classifiedPayloads = payloadsOfType(db, wf.id, 'task_failover_classified') as Array<{ reason: string }>;
    expect(classifiedPayloads[0]?.reason).toBe('context_overflow');

    const compactedPayloads = payloadsOfType(db, wf.id, 'context_compacted') as Array<{
      tokensBefore: number;
      tokensAfter: number;
    }>;
    expect(compactedPayloads[0]?.tokensBefore).toBeGreaterThan(0);
    expect(compactedPayloads[0]?.tokensAfter).toBeGreaterThan(0);

    expect(calls).toBe(2);

    db.close();
  });

  it('compaction failure (callOmniroute throws) preserves abort behavior', async () => {
    const db = initDb(':memory:');
    mockCallOmniroute.mockRejectedValueOnce(new Error('Omniroute unavailable'));

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'big-task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: null,
        },
      ],
    };

    const failingExecute = async (_t: Task): Promise<string> => {
      throw new Error('Request exceeds maximum context length of 200000 tokens');
    };

    let thrown: unknown;
    try {
      await executeWorkflow(db, dag, '__test__', 'x', {
        executeTaskFn: failingExecute,
        consolidateFn: async () => 'c',
        autoApprove: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const types = eventTypes(db, wfRow.id);

    // Should emit task_needs_compaction but NOT context_compacted (compaction failed)
    expect(types).toContain('task_needs_compaction');
    expect(types).not.toContain('context_compacted');
    // Should NOT retry (aborted after compaction failure)
    expect(types).not.toContain('task_retrying');

    db.close();
  });
});
