/**
 * Consolidation Orchestrator Tests
 *
 * Tests for the consolidation orchestrator module that coordinates
 * multi-agent result consolidation.
 */

import { describe, it, expect } from 'vitest';
import {
  orchestrateConsolidation,
  type ConsolidationOrchestratorInput,
} from '../../../src/v2/meta-orchestrator/consolidation-orchestrator.js';

describe('Consolidation Orchestrator', () => {
  describe('orchestrateConsolidation', () => {
    it('should return fallback when all children failed', async () => {
      const input: ConsolidationOrchestratorInput = {
        workflow_id: 'test-meta',
        workflow_objective: 'Test objective',
        child_outcomes: [
          {
            id: 'agent-1',
            workflow_id: 'wf-1',
            status: 'failed',
            error: 'Test error',
            duration_ms: 1000,
          },
          {
            id: 'agent-2',
            workflow_id: 'wf-2',
            status: 'failed',
            error: 'Another error',
            duration_ms: 1000,
          },
        ],
      };

      const result = await orchestrateConsolidation(input);

      expect(result.consolidation_mode).toBe('fallback');
      expect(result.summary).toContain('Multi-agent workflow execution complete');
      expect(result.summary).toContain('agent-1: failed');
      expect(result.summary).toContain('agent-2: failed');
      expect(result.error).toBe('All child workflows failed');
    });

    it('should return consolidated summary when at least one child succeeded', async () => {
      const input: ConsolidationOrchestratorInput = {
        workflow_id: 'test-meta',
        workflow_objective: 'Test objective',
        child_outcomes: [
          {
            id: 'agent-1',
            workflow_id: 'wf-1',
            status: 'completed',
            summary: 'Agent 1 result',
            duration_ms: 1000,
          },
          {
            id: 'agent-2',
            workflow_id: 'wf-2',
            status: 'failed',
            error: 'Test error',
            duration_ms: 1000,
          },
        ],
      };

      const result = await orchestrateConsolidation(input);

      expect(result.consolidation_mode).toBe('fallback');
      expect(result.summary).toContain('Successful agents (1)');
      expect(result.summary).toContain('agent-1: Agent 1 result');
      expect(result.summary).toContain('Failed/cancelled agents (1)');
      expect(result.summary).toContain('agent-2: failed');
      expect(result.conflicts).toEqual([]);
    });

    it('should detect gaps for failed agents', async () => {
      const input: ConsolidationOrchestratorInput = {
        workflow_id: 'test-meta',
        workflow_objective: 'Test objective',
        child_outcomes: [
          {
            id: 'agent-1',
            workflow_id: 'wf-1',
            status: 'completed',
            summary: 'Agent 1 result',
            duration_ms: 1000,
          },
          {
            id: 'agent-2',
            workflow_id: 'wf-2',
            status: 'failed',
            error: 'Test error',
            duration_ms: 1000,
          },
        ],
      };

      const result = await orchestrateConsolidation(input);

      expect(result.gaps).toContain('agent-2: failed');
    });

    it('should handle multiple successful agents', async () => {
      const input: ConsolidationOrchestratorInput = {
        workflow_id: 'test-meta',
        workflow_objective: 'Test objective',
        child_outcomes: [
          {
            id: 'agent-1',
            workflow_id: 'wf-1',
            status: 'completed',
            summary: 'Agent 1 result',
            duration_ms: 1000,
          },
          {
            id: 'agent-2',
            workflow_id: 'wf-2',
            status: 'completed',
            summary: 'Agent 2 result',
            duration_ms: 1000,
          },
          {
            id: 'agent-3',
            workflow_id: 'wf-3',
            status: 'completed',
            summary: 'Agent 3 result',
            duration_ms: 1000,
          },
        ],
      };

      const result = await orchestrateConsolidation(input);

      expect(result.consolidation_mode).toBe('fallback');
      expect(result.summary).toContain('Successful agents (3)');
      expect(result.summary).toContain('agent-1: Agent 1 result');
      expect(result.summary).toContain('agent-2: Agent 2 result');
      expect(result.summary).toContain('agent-3: Agent 3 result');
      expect(result.gaps).toEqual([]);
    });

    it('should handle cancelled agents', async () => {
      const input: ConsolidationOrchestratorInput = {
        workflow_id: 'test-meta',
        workflow_objective: 'Test objective',
        child_outcomes: [
          {
            id: 'agent-1',
            workflow_id: 'wf-1',
            status: 'completed',
            summary: 'Agent 1 result',
            duration_ms: 1000,
          },
          {
            id: 'agent-2',
            workflow_id: 'wf-2',
            status: 'cancelled',
            error: 'User cancelled',
            duration_ms: 500,
          },
        ],
      };

      const result = await orchestrateConsolidation(input);

      expect(result.summary).toContain('Failed/cancelled agents (1)');
      expect(result.summary).toContain('agent-2: cancelled');
      expect(result.gaps).toContain('agent-2: cancelled');
    });
  });
});