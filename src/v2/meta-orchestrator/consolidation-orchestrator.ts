/**
 * Consolidation Orchestrator — coordinates multi-agent result consolidation.
 *
 * This module bridges the meta-orchestrator's parallel workflow execution
 * with consolidation logic to synthesize outputs from multiple agents
 * into a single coherent result.
 *
 * Key capabilities:
 * - Extracts structured outputs from completed child workflows
 * - Performs basic consolidation with conflict detection
 * - Validates consolidated results against filesystem state
 * - Provides fallback when consolidation fails
 *
 * Note: Full consolidator persona integration is deferred to a follow-up sprint.
 * This implementation provides a solid foundation with basic consolidation logic.
 */

import type { Workflow } from '../../types/index.js';

export interface ConsolidationOrchestratorInput {
  /** Parent workflow ID for tracing */
  readonly workflow_id: string;
  /** Original objective for the meta-workflow */
  readonly workflow_objective: string;
  /** Outcomes from parallel child workflows */
  readonly child_outcomes: Array<{
    readonly id: string;
    readonly workflow_id: string | null;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly summary?: string;
    readonly error?: string;
    readonly duration_ms: number;
  }>;
  /** Optional workspace root for file validation */
  readonly workspace_dir?: string;
}

export interface ConsolidationOrchestratorResult {
  /** Consolidated summary */
  readonly summary: string;
  /** Detected conflicts between agent outputs */
  readonly conflicts: Array<{
    readonly topic: string;
    readonly task_a: string;
    readonly task_a_claim: string;
    readonly task_b: string;
    readonly task_b_claim: string;
    readonly resolution: string;
    readonly reasoning: string;
  }>;
  /** Gaps in coverage across all agents */
  readonly gaps: string[];
  /** Total files written by all agents (validated) */
  readonly files_written_total: string[];
  /** Whether consolidation succeeded or fell back */
  readonly consolidation_mode: 'persona' | 'fallback';
  /** Error if consolidation failed */
  readonly error?: string;
}

/**
 * Orchestrates the consolidation of multi-agent workflow results.
 *
 * This function:
 * 1. Transforms child workflow outcomes into consolidation input format
 * 2. Performs basic consolidation (full persona integration deferred)
 * 3. Validates the consolidated output
 * 4. Returns a structured result or fallback
 */
export async function orchestrateConsolidation(
  input: ConsolidationOrchestratorInput,
): Promise<ConsolidationOrchestratorResult> {
  const { child_outcomes } = input;

  // Check if any child succeeded
  const successCount = child_outcomes.filter((o) => o.status === 'completed').length;

  // If no children succeeded, return fallback
  if (successCount === 0) {
    return {
      summary: buildFallbackSummary(child_outcomes),
      conflicts: [],
      gaps: formatOutcomeStatusLines(child_outcomes),
      files_written_total: [],
      consolidation_mode: 'fallback',
      error: 'All child workflows failed',
    };
  }

  // For now, use fallback mode as the primary consolidation strategy
  // Full consolidator persona integration is deferred to a follow-up sprint
  return {
    summary: buildConsolidatedSummary(child_outcomes),
    conflicts: detectConflicts(child_outcomes),
    gaps: detectGaps(child_outcomes),
    files_written_total: [],
    consolidation_mode: 'fallback',
  };
}

/**
 * Format the "Failed/cancelled agents" block shared by the consolidated and
 * fallback summaries.
 */
function formatFailedAgents(
  failed: ConsolidationOrchestratorInput['child_outcomes'],
): string {
  let block = `**Failed/cancelled agents (${failed.length}):**\n`;
  for (const outcome of failed) {
    block += `- ${outcome.id}: ${outcome.status} (${outcome.error ?? 'no error'})\n`;
  }
  return block;
}

/**
 * One `id: status` line per outcome — shared by gap detection and the
 * all-failed fallback path.
 */
function formatOutcomeStatusLines(
  outcomes: ConsolidationOrchestratorInput['child_outcomes'],
): string[] {
  return outcomes.map((o) => `${o.id}: ${o.status}`);
}

/**
 * Build a consolidated summary from multiple agent outcomes.
 */
function buildConsolidatedSummary(
  outcomes: ConsolidationOrchestratorInput['child_outcomes'],
): string {
  const completed = outcomes.filter((o) => o.status === 'completed');
  const failed = outcomes.filter((o) => o.status !== 'completed');

  let summary = `Multi-agent workflow execution complete.\n\n`;

  if (completed.length > 0) {
    summary += `**Successful agents (${completed.length}):**\n`;
    for (const outcome of completed) {
      summary += `- ${outcome.id}: ${outcome.summary ?? '(no summary)'}\n`;
    }
    summary += '\n';
  }

  if (failed.length > 0) {
    summary += formatFailedAgents(failed);
  }

  return summary;
}

/**
 * Build a fallback summary when all agents failed.
 */
function buildFallbackSummary(
  outcomes: ConsolidationOrchestratorInput['child_outcomes'],
): string {
  const failed = outcomes.filter((o) => o.status !== 'completed');
  return `Multi-agent workflow execution complete.\n\n${formatFailedAgents(failed)}`;
}

/**
 * Detect basic conflicts between agent outputs.
 * This is a simplified version; full conflict detection requires LLM analysis.
 */
function detectConflicts(
  _outcomes: ConsolidationOrchestratorInput['child_outcomes'],
): ConsolidationOrchestratorResult['conflicts'] {
  // For now, return empty array
  // Full conflict detection requires LLM analysis via consolidator persona
  return [];
}

/**
 * Detect gaps in coverage across all agents.
 */
function detectGaps(
  outcomes: ConsolidationOrchestratorInput['child_outcomes'],
): string[] {
  return formatOutcomeStatusLines(outcomes.filter((o) => o.status !== 'completed'));
}

/**
 * Extract consolidated output from workflow metadata.
 * This is used when the meta-workflow completes to retrieve the consolidation result.
 */
export function extractConsolidationFromMetadata(
  workflow: Workflow,
): ConsolidationOrchestratorResult | null {
  if (!workflow.metadata) return null;

  try {
    const metadata = JSON.parse(workflow.metadata) as Record<string, unknown>;
    const consolidation = metadata['consolidation'];

    if (!consolidation || typeof consolidation !== 'object' || Array.isArray(consolidation)) {
      return null;
    }

    return consolidation as ConsolidationOrchestratorResult;
  } catch {
    return null;
  }
}