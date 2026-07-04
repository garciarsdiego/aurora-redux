import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import {
  consumeVersionedDefinition,
} from '../../src/brain/executor/run-task.js';
import {
  createVersionedDefinition,
  pinVersionedDefinition,
} from '../../src/v2/governance/versioned-registry.js';
import type { Dag } from '../../src/types/index.js';

describe('versioned definitions runtime consumption (Tier 0 Wave 3 ITEM 0.7)', () => {
  it('emits a versioned_definition_consumed event when an advisor pin exists at task dispatch', async () => {
    const db = initDb(':memory:');
    try {
      const def = createVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'advisor.codereview',
        version: '1.4.2',
        spec: { system_prompt: 'You are a strict code reviewer.' },
        status: 'active',
      });
      pinVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'advisor.codereview',
        versionId: def.id,
        pinnedBy: 'test',
      });

      // Seed a workflow row so the usage record's workflow_id is valid.
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at)
         VALUES ('wf_vd_runtime', 'internal', 't', 'pending', ?)`,
      ).run(Date.now());

      const consumed = consumeVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'advisor.codereview',
        workflowId: 'wf_vd_runtime',
        role: 'advisor',
      });
      expect(consumed).not.toBeNull();
      expect(consumed!.version).toBe('1.4.2');

      const events = db
        .prepare(`SELECT type, payload_json AS payload FROM events WHERE workflow_id = ? ORDER BY id`)
        .all('wf_vd_runtime') as Array<{ type: string; payload: string }>;
      const consumedEvent = events.find((e) => e.type === 'versioned_definition_consumed');
      expect(consumedEvent).toBeDefined();
      const payload = JSON.parse(consumedEvent!.payload) as Record<string, unknown>;
      expect(payload['name']).toBe('advisor.codereview');
      expect(payload['version']).toBe('1.4.2');
      expect(payload['role']).toBe('advisor');

      // Usage row written for audit replay.
      const usageRow = db
        .prepare(`SELECT definition_id, role FROM versioned_definition_usages WHERE workflow_id = ?`)
        .get('wf_vd_runtime') as { definition_id: string; role: string } | undefined;
      expect(usageRow).toBeDefined();
      expect(usageRow!.definition_id).toBe(def.id);
      expect(usageRow!.role).toBe('advisor');
    } finally {
      db.close();
    }
  });

  it('returns null and emits no event when no pin exists for the requested name', () => {
    const db = initDb(':memory:');
    try {
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at)
         VALUES ('wf_no_pin', 'internal', 't', 'pending', ?)`,
      ).run(Date.now());

      const consumed = consumeVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'advisor.nonexistent',
        workflowId: 'wf_no_pin',
        role: 'advisor',
      });
      expect(consumed).toBeNull();
      const events = db
        .prepare(`SELECT type FROM events WHERE workflow_id = ?`)
        .all('wf_no_pin') as Array<{ type: string }>;
      expect(events.some((e) => e.type === 'versioned_definition_consumed')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('consumes a pinned reviewer for every executed task end-to-end', async () => {
    const db = initDb(':memory:');
    try {
      const reviewerDef = createVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'persona.reviewer',
        version: '2.0.0',
        spec: { system_prompt: 'Reviewer override v2.' },
        status: 'active',
      });
      pinVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'persona.reviewer',
        versionId: reviewerDef.id,
        pinnedBy: 'test',
      });

      const dag: Dag = {
        tasks: [
          {
            id: 't1',
            name: 'A simple llm_call',
            kind: 'llm_call',
            depends_on: [],
            acceptance_criteria: 'output is non-empty',
          },
        ],
      };

      await executeWorkflow(db, dag, 'internal', 'pinned reviewer end-to-end', {
        executeTaskFn: async () => 'concrete output',
        reviewFn: async () => ({ score: 1, feedback: 'ok', passed: true }),
        consolidateFn: async () => 'consolidated',
      });

      // The runtime should have emitted versioned_definition_consumed for the
      // reviewer pin on the executed task.
      const events = db
        .prepare(
          `SELECT type, payload_json AS payload FROM events
             WHERE type = 'versioned_definition_consumed'
             ORDER BY id`,
        )
        .all() as Array<{ type: string; payload: string }>;
      const reviewerEvent = events.find((e) => {
        const p = JSON.parse(e.payload) as Record<string, unknown>;
        return p['name'] === 'persona.reviewer';
      });
      expect(reviewerEvent).toBeDefined();
      const payload = JSON.parse(reviewerEvent!.payload) as Record<string, unknown>;
      expect(payload['version']).toBe('2.0.0');
      expect(payload['role']).toBe('reviewer');
    } finally {
      db.close();
    }
  });
});
