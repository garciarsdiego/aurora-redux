/**
 * Action Gate Security Tests (Sprint 9)
 *
 * Tests for the action gate authorization mechanism.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { evaluateActionGate } from '../../src/v2/security/action-gate.js';

describe('Action Gate Security', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create an in-memory database for testing
    db = new Database(':memory:');
    
    // Create the agent_action_policies table
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_action_policies (
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        disposition TEXT NOT NULL,
        PRIMARY KEY (agent_id, category)
      )
    `);

    // Seed default policies
    db.exec(`
      INSERT INTO agent_action_policies (agent_id, category, disposition)
      VALUES ('__default__', 'command_execution', 'allow')
    `);
  });

  it('should allow exempt tools without DB check', () => {
    const result = evaluateActionGate('omniforge_get_workflow_status', 'test-agent', db);
    
    expect(result.disposition).toBe('allow');
    expect(result.category).toBe('exempt');
    expect(result.summary).toContain('exempt read-only coordination tool');
  });

  it('should allow tools when DB policy says allow', () => {
    db.exec(`
      INSERT INTO agent_action_policies (agent_id, category, disposition)
      VALUES ('test-agent', 'file_write_delete', 'allow')
    `);

    const result = evaluateActionGate('file-write', 'test-agent', db);
    
    expect(result.disposition).toBe('allow');
    expect(result.category).toBe('file_write_delete');
  });

  it('should block tools when DB policy says block', () => {
    db.exec(`
      INSERT INTO agent_action_policies (agent_id, category, disposition)
      VALUES ('test-agent', 'command_execution', 'block')
    `);

    const result = evaluateActionGate('bash', 'test-agent', db);
    
    expect(result.disposition).toBe('block');
    expect(result.category).toBe('command_execution');
  });

  it('should require approval when DB policy says require-approval', () => {
    db.exec(`
      INSERT INTO agent_action_policies (agent_id, category, disposition)
      VALUES ('test-agent', 'network_api', 'require-approval')
    `);

    const result = evaluateActionGate('http-request', 'test-agent', db);
    
    expect(result.disposition).toBe('require-approval');
    expect(result.category).toBe('network_api');
  });

  it('should fall back to default policy for unknown agents', () => {
    db.exec(`
      INSERT INTO agent_action_policies (agent_id, category, disposition)
      VALUES ('__default__', 'network_api', 'block')
    `);

    const result = evaluateActionGate('http-request', 'unknown-agent', db);
    
    expect(result.disposition).toBe('block');
    expect(result.category).toBe('network_api');
  });

  it('should default to allow when no policy exists', () => {
    const result = evaluateActionGate('bash', 'unknown-agent', db);
    
    expect(result.disposition).toBe('allow');
  });

  it('should safely fallback to allow when DB is unavailable', () => {
    const badDb = null as unknown as Database.Database;
    
    // This should not throw an error
    const result = evaluateActionGate('bash', 'test-agent', badDb);
    
    expect(result.disposition).toBe('allow');
  });

  it('should classify tools correctly', () => {
    const bashResult = evaluateActionGate('bash', 'test-agent', db);
    expect(bashResult.category).toBe('command_execution');

    const fileWriteResult = evaluateActionGate('file-write', 'test-agent', db);
    expect(fileWriteResult.category).toBe('file_write_delete');

    const httpResult = evaluateActionGate('http-request', 'test-agent', db);
    expect(httpResult.category).toBe('network_api');

    const workflowResult = evaluateActionGate('omniforge_run_workflow', 'test-agent', db);
    expect(workflowResult.category).toBe('task_agent_mutation');
  });

  it('should treat advisor tools as task_agent_mutation', () => {
    const result = evaluateActionGate('omniforge_advisor_analyze', 'test-agent', db);
    
    expect(result.category).toBe('task_agent_mutation');
  });

  it('should treat unknown tools as task_agent_mutation (most restrictive)', () => {
    const result = evaluateActionGate('unknown_tool', 'test-agent', db);
    
    expect(result.category).toBe('task_agent_mutation');
  });
});