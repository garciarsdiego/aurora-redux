/**
 * Meta-Orchestrator Tests
 *
 * Tests for the meta-orchestrator index module that coordinates
 * parallel workflow execution with consolidation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runMetaWorkflow,
  type MetaWorkflowSpec,
  type MetaWorkflowResult,
} from '../../../src/v2/meta-orchestrator/index.js';

// Mock dependencies
vi.mock('../../../src/brain/executor/stream-fork-dispatcher.js', () => ({
  dispatchStreamFork: vi.fn(),
}));

vi.mock('../../../src/v2/meta-orchestrator/consolidation-orchestrator.js', () => ({
  orchestrateConsolidation: vi.fn(),
}));

import { dispatchStreamFork } from '../../../src/brain/executor/stream-fork-dispatcher.js';
import { orchestrateConsolidation } from '../../../src/v2/meta-orchestrator/consolidation-orchestrator.js';

describe('Meta-Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runMetaWorkflow', () => {
    const mockRunWorkflow = vi.fn();

    it('should throw on duplicate spec ids', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test' },
        { id: 'agent-1', workspace: 'internal', objective: 'Test 2' },
      ];

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run }) => {
        for (const item of [{ id: 'agent-1', spec: specs[0]! }]) {
          await run(item);
        }
        return Promise.resolve();
      });

      await expect(
        runMetaWorkflow(specs, { runWorkflow: mockRunWorkflow }),
      ).rejects.toThrow('Duplicate meta-workflow spec id: agent-1');
    });

    it('should execute workflows in parallel', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
        { id: 'agent-2', workspace: 'internal', objective: 'Test 2' },
      ];

      mockRunWorkflow.mockResolvedValue({
        id: 'wf-1',
        status: 'completed',
        objective: 'Test 1',
        workspace: 'internal',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
        pattern_id: null,
      });

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of [
          { id: 'agent-1', spec: specs[0]! },
          { id: 'agent-2', spec: specs[1]! },
        ]) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      vi.mocked(orchestrateConsolidation).mockResolvedValue({
        summary: 'Consolidated',
        conflicts: [],
        gaps: [],
        files_written_total: [],
        consolidation_mode: 'persona',
      });

      const result = await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        consolidate: false,
      });

      expect(mockRunWorkflow).toHaveBeenCalledTimes(2);
      expect(result.children).toHaveLength(2);
      expect(result.all_succeeded).toBe(true);
      expect(result.any_failed).toBe(false);
    });

    it('should handle workflow failures', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
        { id: 'agent-2', workspace: 'internal', objective: 'Test 2' },
      ];

      mockRunWorkflow
        .mockResolvedValueOnce({
          id: 'wf-1',
          status: 'completed',
          objective: 'Test 1',
          workspace: 'internal',
          started_at: Date.now(),
          completed_at: Date.now(),
          created_at: Date.now(),
          created_by: null,
          estimated_cost_usd: null,
          actual_cost_usd: null,
          max_total_cost_usd: null,
          max_duration_seconds: null,
          metadata: null,
          pattern_id: null,
        })
        .mockResolvedValueOnce({
          id: 'wf-2',
          status: 'failed',
          objective: 'Test 2',
          workspace: 'internal',
          started_at: Date.now(),
          completed_at: Date.now(),
          created_at: Date.now(),
          created_by: null,
          estimated_cost_usd: null,
          actual_cost_usd: null,
          max_total_cost_usd: null,
          max_duration_seconds: null,
          metadata: null,
          pattern_id: null,
        });

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of [
          { id: 'agent-1', spec: specs[0]! },
          { id: 'agent-2', spec: specs[1]! },
        ]) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      const result = await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        consolidate: false,
      });

      expect(result.all_succeeded).toBe(false);
      expect(result.any_failed).toBe(true);
      expect(result.children[0]?.status).toBe('completed');
      expect(result.children[1]?.status).toBe('failed');
    });

    it('should run consolidation when enabled', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
      ];

      mockRunWorkflow.mockResolvedValue({
        id: 'wf-1',
        status: 'completed',
        objective: 'Test 1',
        workspace: 'internal',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
        pattern_id: null,
      });

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of [{ id: 'agent-1', spec: specs[0]! }]) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      const mockConsolidationResult = {
        summary: 'Consolidated summary',
        conflicts: [],
        gaps: [],
        files_written_total: [],
        consolidation_mode: 'persona' as const,
      };

      vi.mocked(orchestrateConsolidation).mockResolvedValue(mockConsolidationResult);

      const result = await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        consolidate: true,
      });

      expect(orchestrateConsolidation).toHaveBeenCalledTimes(1);
      expect(orchestrateConsolidation).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow_objective: 'Test 1',
          child_outcomes: expect.any(Array),
        }),
      );
      expect(result.consolidation).toEqual(mockConsolidationResult);
    });

    it('should skip consolidation when disabled', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
      ];

      mockRunWorkflow.mockResolvedValue({
        id: 'wf-1',
        status: 'completed',
        objective: 'Test 1',
        workspace: 'internal',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
        pattern_id: null,
      });

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of [{ id: 'agent-1', spec: specs[0]! }]) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      const result = await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        consolidate: false,
      });

      expect(orchestrateConsolidation).not.toHaveBeenCalled();
      expect(result.consolidation).toBeUndefined();
    });

    it('should respect maxConcurrency parameter', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
        { id: 'agent-2', workspace: 'internal', objective: 'Test 2' },
        { id: 'agent-3', workspace: 'internal', objective: 'Test 3' },
      ];

      mockRunWorkflow.mockResolvedValue({
        id: 'wf-1',
        status: 'completed',
        objective: 'Test',
        workspace: 'internal',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
        pattern_id: null,
      });

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of specs.map((s) => ({ id: s.id, spec: s }))) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        maxConcurrency: 2,
        consolidate: false,
      });

      expect(dispatchStreamFork).toHaveBeenCalledWith(
        expect.objectContaining({
          maxConcurrency: 2,
          initialReady: expect.any(Array),
          run: expect.any(Function),
          onComplete: expect.any(Function),
          onError: expect.any(Function),
        }),
      );
    });

    it('should call onChildSettled callback for each child', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
        { id: 'agent-2', workspace: 'internal', objective: 'Test 2' },
      ];

      mockRunWorkflow.mockResolvedValue({
        id: 'wf-1',
        status: 'completed',
        objective: 'Test',
        workspace: 'internal',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
        pattern_id: null,
      });

      const onChildSettled = vi.fn();

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of [
          { id: 'agent-1', spec: specs[0]! },
          { id: 'agent-2', spec: specs[1]! },
        ]) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        onChildSettled,
        consolidate: false,
      });

      expect(onChildSettled).toHaveBeenCalledTimes(2);
    });

    it('should pass workspaceDir to consolidation when provided', async () => {
      const specs: readonly MetaWorkflowSpec[] = [
        { id: 'agent-1', workspace: 'internal', objective: 'Test 1' },
      ];

      mockRunWorkflow.mockResolvedValue({
        id: 'wf-1',
        status: 'completed',
        objective: 'Test 1',
        workspace: 'internal',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
        pattern_id: null,
      });

      vi.mocked(dispatchStreamFork).mockImplementation(async ({ run, onComplete }) => {
        for (const item of [{ id: 'agent-1', spec: specs[0]! }]) {
          await run(item);
          onComplete?.(item);
        }
        return Promise.resolve();
      });

      vi.mocked(orchestrateConsolidation).mockResolvedValue({
        summary: 'Consolidated',
        conflicts: [],
        gaps: [],
        files_written_total: [],
        consolidation_mode: 'persona',
      });

      await runMetaWorkflow(specs, {
        runWorkflow: mockRunWorkflow,
        consolidate: true,
        workspaceDir: '/path/to/workspace',
      });

      expect(orchestrateConsolidation).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_dir: '/path/to/workspace',
        }),
      );
    });
  });
});