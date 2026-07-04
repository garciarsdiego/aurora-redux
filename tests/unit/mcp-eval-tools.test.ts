import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TOOLS } from '../../src/mcp/server.js';
import { registerEvalCaseTool } from '../../src/mcp/tools/register_eval_case.js';
import { listEvalCasesTool } from '../../src/mcp/tools/list_eval_cases.js';
import { getEvalRunTool } from '../../src/mcp/tools/get_eval_run.js';
import { initDb } from '../../src/db/client.js';
import { registerEvalCase, runEvalSuite } from '../../src/v2/evals/harness.js';

describe('MCP eval registry tools', () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omniforge-eval-mcp-'));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = join(tempDir, 'omniforge.db');
  });

  afterEach(async () => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('registers eval tools in the MCP tool list', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('omniforge_register_eval_case');
    expect(names).toContain('omniforge_list_eval_cases');
    expect(names).toContain('omniforge_get_eval_run');
  });

  it('registers and lists eval cases for a workspace', async () => {
    const created = JSON.parse(await registerEvalCaseTool({
      workspace: 'internal',
      name: 'simple-summary',
      input: { text: 'A. B. C.' },
      expected: { bullets: 3 },
      tags: ['golden', 'summary'],
    })) as { id: string; name: string; tags: string[] };

    expect(created.id).toMatch(/^ec_/);
    expect(created.name).toBe('simple-summary');
    expect(created.tags).toEqual(['golden', 'summary']);

    const listed = JSON.parse(await listEvalCasesTool({
      workspace: 'internal',
      tags: ['golden'],
    })) as Array<{ id: string; name: string }>;

    expect(listed).toEqual([
      expect.objectContaining({ id: created.id, name: 'simple-summary' }),
    ]);
  });

  it('returns an eval run with case results', async () => {
    const db = initDb(process.env.DB_PATH!);
    try {
      registerEvalCase(db, {
        workspace: 'internal',
        name: 'exact',
        input: { value: 1 },
        expected: { value: 2 },
        tags: ['golden'],
      });
      const run = await runEvalSuite(db, {
        workspace: 'internal',
        suiteName: 'smoke',
        tags: ['golden'],
        runner: async (testCase) => testCase.expected,
      });

      const payload = JSON.parse(await getEvalRunTool({ run_id: run.id })) as {
        run: { id: string; score: number };
        results: Array<{ status: string; score: number }>;
      };

      expect(payload.run.id).toBe(run.id);
      expect(payload.run.score).toBe(1);
      expect(payload.results).toEqual([
        expect.objectContaining({ status: 'passed', score: 1 }),
      ]);
    } finally {
      db.close();
    }
  });
});
