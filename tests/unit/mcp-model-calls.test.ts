import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initDb } from '../../src/db/client.js';
import { recordModelCall } from '../../src/v2/llm-ledger/store.js';
import { TOOLS } from '../../src/mcp/server.js';
import {
  GetModelCallsSchema,
  getModelCallsTool,
} from '../../src/mcp/tools/get_model_calls.js';

describe('omniforge_get_model_calls MCP tool', () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omniforge-model-calls-mcp-'));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = join(tempDir, 'omniforge.db');
  });

  afterEach(async () => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('is registered in the MCP tool list', () => {
    expect(TOOLS.map((t) => t.name)).toContain('omniforge_get_model_calls');
  });

  it('validates workflow_id input', () => {
    expect(GetModelCallsSchema.parse({ workflow_id: 'wf_1' }).workflow_id).toBe('wf_1');
    expect(() => GetModelCallsSchema.parse({ workflow_id: '' })).toThrow();
  });

  it('returns calls and aggregate totals for a workflow', async () => {
    const db = initDb(process.env.DB_PATH!);
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_calls', 'internal', 'calls', 'pending', ?)`,
    ).run(Date.now());
    recordModelCall(db, {
      workflowId: 'wf_calls',
      model: 'cc/claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      latencyMs: 100,
      source: 'test',
    });
    recordModelCall(db, {
      workflowId: 'wf_calls',
      model: 'cc/claude-haiku-4-5',
      inputTokens: 4,
      outputTokens: 2,
      costUsd: 0.005,
      latencyMs: 50,
      source: 'test',
    });
    db.close();

    const parsed = JSON.parse(await getModelCallsTool({ workflow_id: 'wf_calls' })) as {
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      calls: unknown[];
    };

    expect(parsed.total_cost_usd).toBeCloseTo(0.015, 6);
    expect(parsed.total_input_tokens).toBe(14);
    expect(parsed.total_output_tokens).toBe(7);
    expect(parsed.calls).toHaveLength(2);
  });
});
