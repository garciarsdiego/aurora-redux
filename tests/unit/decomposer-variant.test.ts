// Week 3 / Task 2.2 — prompt-variant A/B selection for the decomposer.
//
// Asserts that when an `eval_active_variants` row points the decomposer at
// a registered prompt variant for a workspace, the variant's `prompt_text`
// is preferred over the baseline SYSTEM_PROMPT, and a
// `decomposer_variant_used` audit event lands on the workflow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { getDbPath } from '../../src/utils/config.js';
import {
  insertWorkflowWithTasks,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import type { Workflow, Task } from '../../src/types/index.js';

// Inline variant seeding (the legacy PromptVariantManager helper in
// src/v2/evals/runners was removed as dead code — GHOST-08/INTEL-07). These
// two helpers reproduce its exact INSERTs into the migration-051/052 tables so
// this test keeps exercising the decomposer's runtime variant lookup.
function seedDecomposerVariant(
  db: Database.Database,
  workspace: string,
  name: string,
  promptText: string,
): { id: string } {
  const id = `pv_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO eval_prompt_variants
       (id, workspace, component, name, prompt_text, few_shots_json, metadata_json, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, workspace, 'decomposer', name, promptText, '[]', '{}', null, Date.now());
  return { id };
}

function activateDecomposerVariant(
  db: Database.Database,
  workspace: string,
  variantId: string,
  activatedBy: string,
): void {
  db.prepare(
    `DELETE FROM eval_active_variants WHERE workspace = ? AND component = ?`,
  ).run(workspace, 'decomposer');
  db.prepare(
    `INSERT INTO eval_active_variants
       (id, workspace, component, variant_id, activated_at, activated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`av_${crypto.randomUUID()}`, workspace, 'decomposer', variantId, Date.now(), activatedBy);
}

function makeWorkflow(id: string, workspace: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective: 'variant routing test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: 'variant_test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(wfId: string, id: string): Task {
  const now = Date.now();
  return {
    id,
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
  };
}

describe('decomposer variant A/B routing', () => {
  let db: Database.Database;
  const workspace = 'variant_routing_test';
  const wfIds: string[] = [];
  const variantIds: string[] = [];

  let originalPersonas: string | undefined;

  beforeEach(() => {
    db = initDb(getDbPath());
    // Variant routing wired in the legacy decomposer path; force off the
    // persona path which has stricter output validation and would reject
    // the simplified DAG returned by the mock.
    originalPersonas = process.env.OMNIFORGE_USE_PERSONAS;
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
  });

  afterEach(() => {
    for (const wfId of wfIds) {
      db.prepare('DELETE FROM events WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
    }
    for (const vid of variantIds) {
      db.prepare('DELETE FROM eval_active_variants WHERE variant_id = ?').run(vid);
      db.prepare('DELETE FROM eval_prompt_variants WHERE id = ?').run(vid);
    }
    wfIds.length = 0;
    variantIds.length = 0;
    db.close();
    vi.restoreAllMocks();
    if (originalPersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalPersonas;
  });

  it('selects the active variant prompt and emits a decomposer_variant_used event', async () => {
    // Seed a workflow with one task so events have a valid FK target.
    const wfId = newWorkflowId();
    wfIds.push(wfId);
    insertWorkflowWithTasks(db, makeWorkflow(wfId, workspace), [makeTask(wfId, newTaskId())]);

    // Register and activate a decomposer variant for this workspace.
    const variant = seedDecomposerVariant(
      db,
      workspace,
      'extended-fewshots-v1',
      'OMNIFORGE_TEST_VARIANT_SENTINEL — extended few-shots',
    );
    variantIds.push(variant.id);
    activateDecomposerVariant(db, workspace, variant.id, 'variant_test');

    // Stub Omniroute so we can observe the systemPrompt that the decomposer
    // ships to the LLM without making a real network call.
    const callMod = await import('../../src/utils/omniroute-call.js');
    let observedSystemPrompt = '';
    const fakeCall = vi
      .spyOn(callMod, 'callOmnirouteWithUsage')
      .mockImplementation(async (input) => {
        observedSystemPrompt = input.systemPrompt;
        return {
          content: JSON.stringify({
            tasks: [
              {
                id: 't0',
                name: 'Review plan',
                kind: 'llm_call',
                depends_on: [],
                executor_hint: null,
                acceptance_criteria: 'Plan enumerates the two tasks below and confirms exit code equals 0',
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
          }),
          usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0 },
          model_used: 'cc/claude-sonnet-4-6',
        };
      });

    const { decompose } = await import('../../src/brain/decomposer.js');
    await decompose('Variant routing smoke test', {
      db,
      workflowId: wfId,
      workspace,
    });
    fakeCall.mockRestore();

    expect(observedSystemPrompt).toContain('OMNIFORGE_TEST_VARIANT_SENTINEL');

    const event = db
      .prepare(
        `SELECT type, payload_json FROM events
          WHERE workflow_id = ? AND type = 'decomposer_variant_used'`,
      )
      .get(wfId) as { type: string; payload_json: string } | undefined;
    expect(event).toBeDefined();
    const payload = JSON.parse(event!.payload_json) as { variant_id: string; variant_name: string };
    expect(payload.variant_id).toBe(variant.id);
    expect(payload.variant_name).toBe('extended-fewshots-v1');
  });

  it('falls back to the baseline prompt when no variant is active', async () => {
    const wfId = newWorkflowId();
    wfIds.push(wfId);
    insertWorkflowWithTasks(db, makeWorkflow(wfId, workspace), [makeTask(wfId, newTaskId())]);

    const callMod = await import('../../src/utils/omniroute-call.js');
    let observedSystemPrompt = '';
    const fakeCall = vi
      .spyOn(callMod, 'callOmnirouteWithUsage')
      .mockImplementation(async (input) => {
        observedSystemPrompt = input.systemPrompt;
        return {
          content: JSON.stringify({
            tasks: [
              {
                id: 't0',
                name: 'Review plan',
                kind: 'llm_call',
                depends_on: [],
                executor_hint: null,
                acceptance_criteria: 'Plan enumerates the two tasks below and confirms exit code equals 0',
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
          }),
          usage: { input_tokens: 10, output_tokens: 20, total_cost_usd: 0 },
          model_used: 'cc/claude-sonnet-4-6',
        };
      });

    const { decompose } = await import('../../src/brain/decomposer.js');
    await decompose('Fallback smoke test', {
      db,
      workflowId: wfId,
      workspace,
    });
    fakeCall.mockRestore();

    // Baseline prompt opens with the canonical phrase.
    expect(observedSystemPrompt).toContain("You are Omniforge's task decomposer");
    expect(observedSystemPrompt).not.toContain('OMNIFORGE_TEST_VARIANT_SENTINEL');

    const event = db
      .prepare(
        `SELECT COUNT(*) AS c FROM events
          WHERE workflow_id = ? AND type = 'decomposer_variant_used'`,
      )
      .get(wfId) as { c: number };
    expect(event.c).toBe(0);
  });
});
