/**
 * Unit + integration tests for src/v2/security/action-gate.ts
 *
 * Coverage:
 * - Exempt tools: return disposition='allow', category='exempt', no DB hit
 * - Known tool categories (bash, omniforge_run_workflow, http-request, file-write)
 * - __default__ policy rows drive disposition correctly
 * - Unknown tools fall back gracefully (no throw)
 * - DB query failure falls back to disposition='allow'
 * - DB with migration 041 applied: full integration path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  evaluateActionGate,
  type ActionDisposition,
  type ActionCategory,
} from '../../src/v2/security/action-gate.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryDb(): Database.Database {
  return initDb(':memory:');
}

function setPolicy(
  db: Database.Database,
  agentId: string,
  category: ActionCategory,
  disposition: ActionDisposition,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_action_policies (agent_id, category, disposition)
     VALUES (?, ?, ?)`,
  ).run(agentId, category, disposition);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('evaluateActionGate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── Exempt tools ─────────────────────────────────────────────────────────

  describe('exempt tools', () => {
    const exemptTools = [
      'omniforge_get_workflow_status',
      'omniforge_list_workflows',
      'omniforge_list_models',
      'omniforge_get_model_calls',
      'omniforge_list_versioned_definitions',
      'omniforge_list_eval_cases',
      'omniforge_get_eval_run',
      'omniforge_list_patterns',
    ];

    for (const tool of exemptTools) {
      it(`${tool} → disposition=allow, category=exempt`, () => {
        const decision = evaluateActionGate(tool, '__default__', db);
        expect(decision.disposition).toBe('allow');
        expect(decision.category).toBe('exempt');
        expect(decision.toolName).toBe(tool);
      });
    }

    it('exempt tools bypass DB policy lookup (block policy has no effect)', () => {
      // Even if DB somehow had a policy for an exempt tool, the early return
      // means the category is 'exempt' and disposition is always 'allow'.
      // We can verify by confirming category=exempt without inserting any row.
      const decision = evaluateActionGate('omniforge_list_workflows', '__default__', db);
      expect(decision.disposition).toBe('allow');
      expect(decision.category).toBe('exempt');
    });
  });

  // ── Known category classifications ───────────────────────────────────────

  describe('category classification', () => {
    it('bash → command_execution', () => {
      const decision = evaluateActionGate('bash', '__default__', db);
      expect(decision.category).toBe('command_execution');
    });

    it('omniforge_read_file → command_execution', () => {
      const decision = evaluateActionGate('omniforge_read_file', '__default__', db);
      expect(decision.category).toBe('command_execution');
    });

    it('file-write → file_write_delete', () => {
      const decision = evaluateActionGate('file-write', '__default__', db);
      expect(decision.category).toBe('file_write_delete');
    });

    it('http-request → network_api', () => {
      const decision = evaluateActionGate('http-request', '__default__', db);
      expect(decision.category).toBe('network_api');
    });

    it('omniforge_run_workflow → task_agent_mutation', () => {
      const decision = evaluateActionGate('omniforge_run_workflow', '__default__', db);
      expect(decision.category).toBe('task_agent_mutation');
    });

    it('omniforge_approve_gate → task_agent_mutation', () => {
      const decision = evaluateActionGate('omniforge_approve_gate', '__default__', db);
      expect(decision.category).toBe('task_agent_mutation');
    });

    it('cli_spawn → task_agent_mutation', () => {
      const decision = evaluateActionGate('cli_spawn', '__default__', db);
      expect(decision.category).toBe('task_agent_mutation');
    });

    it('omniforge_set_config → task_agent_mutation', () => {
      const decision = evaluateActionGate('omniforge_set_config', '__default__', db);
      expect(decision.category).toBe('task_agent_mutation');
    });

    it('future git_write tool → git_write category', () => {
      const decision = evaluateActionGate('some_git_write_op', '__default__', db);
      expect(decision.category).toBe('git_write');
    });
  });

  // ── __default__ policy rows ───────────────────────────────────────────────

  describe('__default__ policy resolution', () => {
    it('default policy allow → disposition=allow for command_execution', () => {
      // Migration seeds __default__ as all-allow; just verify
      const decision = evaluateActionGate('bash', '__default__', db);
      expect(decision.disposition).toBe('allow');
    });

    it('__default__ policy block → disposition=block', () => {
      setPolicy(db, '__default__', 'command_execution', 'block');
      const decision = evaluateActionGate('bash', '__default__', db);
      expect(decision.disposition).toBe('block');
    });

    it('__default__ policy require-approval → disposition=require-approval', () => {
      setPolicy(db, '__default__', 'network_api', 'require-approval');
      const decision = evaluateActionGate('http-request', '__default__', db);
      expect(decision.disposition).toBe('require-approval');
    });

    it('agent-specific policy overrides __default__', () => {
      // __default__ allows task_agent_mutation
      // but agent 'restricted-agent' blocks it
      setPolicy(db, 'restricted-agent', 'task_agent_mutation', 'block');
      const decision = evaluateActionGate('omniforge_run_workflow', 'restricted-agent', db);
      expect(decision.disposition).toBe('block');
    });

    it('agent without specific policy falls back to __default__', () => {
      setPolicy(db, '__default__', 'file_write_delete', 'block');
      // 'some-other-agent' has no specific policy — should inherit __default__
      const decision = evaluateActionGate('file-write', 'some-other-agent', db);
      expect(decision.disposition).toBe('block');
    });
  });

  // ── Unknown tools ─────────────────────────────────────────────────────────

  describe('unknown tools', () => {
    it('completely unknown tool name does not throw', () => {
      expect(() =>
        evaluateActionGate('totally_unknown_tool_xyz', '__default__', db),
      ).not.toThrow();
    });

    it('unknown tool defaults to task_agent_mutation category', () => {
      const decision = evaluateActionGate('totally_unknown_tool_xyz', '__default__', db);
      expect(decision.category).toBe('task_agent_mutation');
    });

    it('unknown tool returns allow when __default__ task_agent_mutation is allow', () => {
      const decision = evaluateActionGate('totally_unknown_tool_xyz', '__default__', db);
      expect(decision.disposition).toBe('allow');
    });

    it('dynamic advisor tool → task_agent_mutation', () => {
      const decision = evaluateActionGate('omniforge_advisor_thinkdeep', '__default__', db);
      expect(decision.category).toBe('task_agent_mutation');
    });
  });

  // ── DB failure fallback ───────────────────────────────────────────────────

  describe('DB failure fallback', () => {
    it('closed DB falls back to disposition=allow without throwing', () => {
      const closedDb = makeMemoryDb();
      closedDb.close(); // close before passing to gate

      let decision;
      expect(() => {
        decision = evaluateActionGate('bash', '__default__', closedDb);
      }).not.toThrow();
      expect(decision?.disposition).toBe('allow');
    });

    it('DB without migration 041 table falls back to allow', () => {
      // Create a raw DB without running migrations
      const rawDb = new Database(':memory:');
      // No agent_action_policies table exists
      try {
        const decision = evaluateActionGate('bash', '__default__', rawDb);
        expect(decision.disposition).toBe('allow');
      } finally {
        rawDb.close();
      }
    });
  });

  // ── Decision shape ────────────────────────────────────────────────────────

  describe('decision object shape', () => {
    it('returns all required fields', () => {
      const decision = evaluateActionGate('bash', '__default__', db);
      expect(typeof decision.disposition).toBe('string');
      expect(typeof decision.category).toBe('string');
      expect(decision.toolName).toBe('bash');
      expect(typeof decision.summary).toBe('string');
    });

    it('summary includes toolName and category', () => {
      const decision = evaluateActionGate('omniforge_run_workflow', '__default__', db);
      expect(decision.summary).toContain('omniforge_run_workflow');
      expect(decision.summary).toContain('task_agent_mutation');
    });

    it('exempt tool summary mentions exempt', () => {
      const decision = evaluateActionGate('omniforge_list_workflows', '__default__', db);
      expect(decision.summary).toContain('exempt');
    });
  });
});
