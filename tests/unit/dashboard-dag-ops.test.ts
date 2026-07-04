import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initDb } from '../../src/db/client.js';
import {
  importDashboardDag,
  listDashboardDags,
  parseDashboardDag,
  reconstructWorkflowDag,
} from '../../src/mcp/dashboard-dag-ops.js';

describe('dashboard DAG operations', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omniforge-dashboard-dag-ops-'));
    dbPath = join(tempDir, 'omniforge.db');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses YAML/JSON DAG source and validates the schema', () => {
    const yamlDag = parseDashboardDag(`
tasks:
  - id: t0
    name: Write note
    kind: tool_call
    depends_on: []
    tool_name: file-write
    args:
      path: note.txt
      content: hello
    timeout_seconds: 60
`);
    expect(yamlDag.tasks[0]).toMatchObject({
      id: 't0',
      kind: 'tool_call',
      tool_name: 'file-write',
      args: { path: 'note.txt', content: 'hello' },
    });

    const jsonDag = parseDashboardDag(JSON.stringify(yamlDag));
    expect(jsonDag.tasks).toHaveLength(1);
  });

  it('rejects a dashboard DAG whose dependency graph is not executable', () => {
    expect(() => parseDashboardDag(`
tasks:
  - id: t1
    name: Impossible task
    kind: llm_call
    depends_on: [missing]
    acceptance_criteria: Valid JSON object with field result string and explicit completion status
`)).toThrow(/graph-integrity.*missing/s);
  });

  it('normalizes CLI executor hints to the selected model provider before execution', () => {
    const dag = parseDashboardDag(`
tasks:
  - id: t0
    name: Write Codex artifact
    kind: cli_spawn
    depends_on: []
    executor_hint: cli:gemini
    model: cx/gpt-5.4
    acceptance_criteria: src/index.html exists
`);
    expect(dag.tasks[0]).toMatchObject({
      kind: 'cli_spawn',
      model: 'cx/gpt-5.4',
      executor_hint: 'cli:codex',
    });
  });

  it('imports a DAG into the local pattern library and lists metadata', () => {
    const db = initDb(dbPath);
    try {
      const pattern = importDashboardDag(db, {
        workspace: 'internal',
        name: 'daily-smoke',
        objective_sample: 'Run daily smoke',
        source: `{"tasks":[{"id":"t0","name":"Write","kind":"tool_call","depends_on":[],"tool_name":"file-write","args":{"path":"a.txt","content":"ok"},"timeout_seconds":60}]}`,
      });

      expect(pattern.id).toMatch(/^pt_/);

      const library = listDashboardDags(db, { workspace: 'internal' });
      expect(library).toEqual([
        expect.objectContaining({
          id: pattern.id,
          name: 'daily-smoke',
          task_count: 1,
          kinds: ['tool_call'],
          dag: expect.objectContaining({ tasks: expect.any(Array) }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('reconstructs a replayable DAG from a completed workflow preserving tool args', () => {
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_replay', 'internal', 'Original objective', NULL, 'completed', ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(now - 3_000, now - 1_000, now - 4_000);

      const insertTask = db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
            completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
            model, hitl, execution_mode)
         VALUES (?, 'wf_replay', ?, ?, ?, '{}', 'completed', ?, NULL, 60, 3, 0, 'exponential',
            ?, ?, ?, ?, 0, 2, NULL, ?, 0, 'ephemeral')`,
      );
      insertTask.run(
        'tk_write',
        'Write artifact',
        'tool_call',
        JSON.stringify({
          workspace: 'internal',
          tool_name: 'file-write',
          args: { path: 'replay.txt', content: 'again' },
        }),
        '[]',
        now - 3_000,
        now - 2_000,
        now - 3_000,
        'file is written',
        null,
      );
      insertTask.run(
        'tk_read',
        'Read artifact',
        'tool_call',
        JSON.stringify({
          workspace: 'internal',
          tool_name: 'file-read',
          args: { path: 'replay.txt' },
        }),
        JSON.stringify(['tk_write']),
        now - 2_000,
        now - 1_000,
        now - 2_000,
        null,
        null,
      );

      const replay = reconstructWorkflowDag(db, 'wf_replay');

      expect(replay.workspace).toBe('internal');
      expect(replay.objective).toBe('Original objective');
      expect(replay.dag.tasks).toEqual([
        expect.objectContaining({
          id: 't0',
          name: 'Write artifact',
          tool_name: 'file-write',
          args: { path: 'replay.txt', content: 'again' },
          depends_on: [],
        }),
        expect.objectContaining({
          id: 't1',
          name: 'Read artifact',
          tool_name: 'file-read',
          args: { path: 'replay.txt' },
          depends_on: ['t0'],
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
