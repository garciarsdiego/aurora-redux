/**
 * Decomposer Evaluator - Real Agent Integration
 *
 * Evaluates the actual Omniforge decomposer against golden test cases
 */

import type { TestCase } from './framework.js';
import type { EvaluationOutput, AgentEvaluator } from './framework.js';
import { decompose, type DecomposeOptions } from '../../../brain/decomposer.js';
import type { Dag } from '../../../types/index.js';
import { estimateCost, estimateTokens } from './cost-estimation.js';

// ============================================================================
// FALSIFIABLE CRITERIA PATTERNS (H7)
// ============================================================================
// Single source of truth for the strong/weak language classification used by
// the H7 scoring path (calculateFalsifiableScore / calculateCorrectness).
// Strong patterns indicate verifiable criteria; weak patterns indicate vagueness.
//
// NOTE: the hard validation gate in validateAgainstExpected() has always used
// its own, slightly different weak-pattern list (see HARD_GATE_WEAK_PATTERNS
// below). Keep the two separate — merging them changes which decompositions
// pass/fail validation.

const STRONG_CRITERIA_PATTERNS = ['must', 'should', 'required', 'shall', 'contains', 'exists', 'valid'];
const WEAK_CRITERIA_PATTERNS = ['correct', 'good', 'proper', 'working', 'effective'];

// Weak-pattern list for the hard validation gate (validateAgainstExpected).
// Intentionally distinct from WEAK_CRITERIA_PATTERNS above — this is the
// original list the gate has always used.
const HARD_GATE_WEAK_PATTERNS = ['should', 'must be', 'correct', 'good', 'proper', 'working'];

/**
 * Check if criteria text contains weak (non-falsifiable) language
 */
function hasWeakCriteriaLanguage(criteria: string | null | undefined): boolean {
  const text = criteria?.toLowerCase() || '';
  return WEAK_CRITERIA_PATTERNS.some(pattern => text.includes(pattern));
}

/**
 * Check if criteria text contains weak language per the hard validation gate's
 * (legacy) pattern list
 */
function hasHardGateWeakLanguage(criteria: string | null | undefined): boolean {
  const text = criteria?.toLowerCase() || '';
  return HARD_GATE_WEAK_PATTERNS.some(pattern => text.includes(pattern));
}

/**
 * Check if criteria text is falsifiable (has strong language and no weak language)
 */
function isFalsifiableCriteria(criteria: string | null | undefined): boolean {
  const text = criteria?.toLowerCase() || '';
  const hasStrong = STRONG_CRITERIA_PATTERNS.some(pattern => text.includes(pattern));
  return hasStrong && !hasWeakCriteriaLanguage(criteria);
}

export class DecomposerEvaluator implements AgentEvaluator {
  /**
   * Evaluate a test case using the real Omniforge decomposer
   */
  async evaluate(testCase: TestCase, model: string): Promise<EvaluationOutput> {
    const startTime = Date.now();

    try {
      // Prepare options for decomposer with specific model
      const options: DecomposeOptions = {
        taskModelHint: model, // Override default model with test model
        cwd: testCase.input.context?.workspace || process.cwd(),
        // Add any test-specific context
      };

      // Call the real decomposer
      const dag = await decompose(testCase.input.objective, options);

      const duration = Date.now() - startTime;

      // Calculate cost (rough estimation based on model tier)
      const cost = estimateCost(model, duration);

      // Calculate token usage (rough estimation)
      const tokenUsage = estimateTokens(testCase.complexity);

      // Validate against expected output
      const validation = this.validateAgainstExpected(dag, testCase.expectedOutput);

      return {
        success: validation.isValid,
        output: {
          dag,
          validation,
          metadata: {
            taskCount: dag.tasks.length,
            hasPlanGate: dag.tasks[0]?.id === 't0',
            kinds: [...new Set(dag.tasks.map(t => t.kind))],
            models: [...new Set(dag.tasks.map(t => t.model).filter(Boolean))]
          }
        },
        cost,
        tokenUsage,
        error: validation.isValid ? undefined : validation.error
      };

    } catch (error) {
      return {
        success: false,
        output: null,
        cost: 0,
        tokenUsage: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Calculate decomposer-specific metrics
   */
  calculateMetrics(testCase: TestCase, result: EvaluationOutput) {
    if (!result.success || !result.output) {
      return {
        qualityScore: 0,
        accuracy: 0,
        completeness: 0,
        correctness: 0,
        agentSpecific: {
          granularity: 0,
          falsifiableCriteria: 0,
          taskDependencies: 0,
          planGate: 0,
          modelAssignment: 0,
          h1_granularity: 0,
          h2_fanout: 0,
          h7_falsifiable: 0
        }
      };
    }

    const dag = result.output.dag as Dag;
    const validation = result.output.validation;

    // H1: Granularity (3-7 tasks is ideal for simple/medium)
    const taskCount = dag.tasks.length;
    const expectedCount = testCase.expectedOutput.metadata?.expectedTaskCount || 5;
    const granularityScore = this.calculateGranularityScore(taskCount, expectedCount);

    // H2: Fan-out (independent tasks should be parallel)
    const fanoutScore = this.calculateFanoutScore(dag);

    // H7: Falsifiable Criteria (all non-t0 tasks should have criteria)
    const falsifiableScore = this.calculateFalsifiableScore(dag);

    // Plan gate (t0 should exist with hitl: true)
    const planGateScore = this.calculatePlanGateScore(dag);

    // Model assignment (should match executor hints)
    const modelAssignmentScore = this.calculateModelAssignmentScore(dag);

    // Overall quality score
    const qualityScore = (
      granularityScore * 0.25 +
      fanoutScore * 0.15 +
      falsifiableScore * 0.30 +  // H7 is most important
      planGateScore * 0.10 +
      modelAssignmentScore * 0.20
    );

    // Accuracy (matches expected structure)
    const accuracy = validation.isValid ? 1.0 : 0.0;

    // Completeness (has expected elements)
    const completeness = this.calculateCompleteness(dag, testCase.expectedOutput);

    // Correctness (task quality and dependencies)
    const correctness = this.calculateCorrectness(dag, testCase.expectedOutput);

    return {
      qualityScore,
      accuracy,
      completeness,
      correctness,
      agentSpecific: {
        granularity: granularityScore,
        falsifiableCriteria: falsifiableScore, // H7
        taskDependencies: fanoutScore,
        planGate: planGateScore,
        modelAssignment: modelAssignmentScore,
        h1_granularity: granularityScore,
        h2_fanout: fanoutScore,
        h7_falsifiable: falsifiableScore
      }
    };
  }

  /**
   * Validate decomposer output against expected output
   */
  private validateAgainstExpected(dag: Dag, expected: any): {
    isValid: boolean;
    error?: string;
  } {
    try {
      // Check if task count is reasonable
      const expectedCount = expected.metadata?.expectedTaskCount;
      if (expectedCount) {
        const { tolerance, minTasks, maxTasks } = this.taskCountBounds(expectedCount);

        if (dag.tasks.length < minTasks) {
          return {
            isValid: false,
            error: `Too few tasks: ${dag.tasks.length} (expected ${expectedCount} ± ${tolerance})`
          };
        }

        if (dag.tasks.length > maxTasks) {
          return {
            isValid: false,
            error: `Too many tasks: ${dag.tasks.length} (expected ${expectedCount} ± ${tolerance})`
          };
        }
      }

      // Check if plan gate exists
      if (dag.tasks[0]?.id !== 't0') {
        return {
          isValid: false,
          error: 'Missing plan gate (t0)'
        };
      }

      // Check if all tasks have acceptance criteria
      const tasksWithoutCriteria = dag.tasks.filter(
        t => t.id !== 't0' && (!t.acceptance_criteria || t.acceptance_criteria.trim().length === 0)
      );

      if (tasksWithoutCriteria.length > 0) {
        return {
          isValid: false,
          error: `${tasksWithoutCriteria.length} tasks missing acceptance_criteria`
        };
      }

      // Check falsifiable criteria quality (H7)
      const nonFalsifiable = dag.tasks.filter(
        t => t.id !== 't0' && hasHardGateWeakLanguage(t.acceptance_criteria)
      );

      if (nonFalsifiable.length > 0) {
        return {
          isValid: false,
          error: `${nonFalsifiable.length} tasks have non-falsifiable criteria`
        };
      }

      return { isValid: true };

    } catch (error) {
      return {
        isValid: false,
        error: `Validation error: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Bounds for the expected task count with ±50% tolerance
   */
  private taskCountBounds(expectedCount: number): { tolerance: number; minTasks: number; maxTasks: number } {
    const tolerance = Math.ceil(expectedCount * 0.5); // ±50% tolerance
    return {
      tolerance,
      minTasks: Math.max(3, expectedCount - tolerance),
      maxTasks: expectedCount + tolerance,
    };
  }

  /**
   * Calculate H1 Granularity score
   */
  private calculateGranularityScore(actualCount: number, expectedCount: number): number {
    const idealMin = Math.max(3, expectedCount - 2);
    const idealMax = expectedCount + 2;

    if (actualCount >= idealMin && actualCount <= idealMax) {
      return 1.0; // Perfect granularity
    } else if (actualCount < idealMin) {
      return Math.max(0, 1 - (idealMin - actualCount) / idealMin); // Too coarse
    } else {
      return Math.max(0, 1 - (actualCount - idealMax) / idealMax); // Too fine
    }
  }

  /**
   * Calculate H2 Fan-out score (parallelization efficiency)
   */
  private calculateFanoutScore(dag: Dag): number {
    // Count tasks that depend only on t0 (potential parallel tasks)
    const directDependentsOnT0 = dag.tasks.filter(t =>
      t.depends_on.length === 1 && t.depends_on[0] === 't0' && t.id !== 't0'
    );

    // Count total non-t0 tasks
    const nonT0Tasks = dag.tasks.length - 1;

    if (nonT0Tasks === 0) return 1.0; // Only plan gate, no fan-out needed

    const parallelizationRatio = directDependentsOnT0.length / nonT0Tasks;

    // Ideal: 60-80% of tasks should be parallelizable
    if (parallelizationRatio >= 0.6 && parallelizationRatio <= 0.8) {
      return 1.0;
    } else if (parallelizationRatio < 0.6) {
      return parallelizationRatio / 0.6; // Too serial
    } else {
      return Math.max(0, 1 - (parallelizationRatio - 0.8) / 0.2); // Over-parallelized (suspicious)
    }
  }

  /**
   * Calculate H7 Falsifiable Criteria score (most important metric)
   */
  private calculateFalsifiableScore(dag: Dag): number {
    const nonT0Tasks = dag.tasks.filter(t => t.id !== 't0');
    if (nonT0Tasks.length === 0) return 1.0; // Only plan gate, no criteria needed

    const tasksWithCriteria = nonT0Tasks.filter(t =>
      t.acceptance_criteria && t.acceptance_criteria.trim().length > 0
    );

    const criteriaRate = tasksWithCriteria.length / nonT0Tasks.length;

    // Check quality of criteria (falsifiable language)
    const tasksWithFalsifiable = tasksWithCriteria.filter(t => isFalsifiableCriteria(t.acceptance_criteria));

    const qualityRate = tasksWithFalsifiable.length / Math.max(1, tasksWithCriteria.length);

    return criteriaRate * 0.6 + qualityRate * 0.4; // 60% presence, 40% quality
  }

  /**
   * Calculate Plan Gate score (H11)
   */
  private calculatePlanGateScore(dag: Dag): number {
    const t0 = dag.tasks[0];

    if (!t0 || t0.id !== 't0') return 0.0; // No plan gate
    if (!t0.hitl) return 0.5; // Plan gate exists but not interactive

    const hasValidCriteria = t0.acceptance_criteria &&
      t0.acceptance_criteria.length > 0;

    const correctKind = t0.kind === 'llm_call';

    return (hasValidCriteria ? 0.5 : 0) + (correctKind ? 0.5 : 0);
  }

  /**
   * Calculate Model Assignment score (H10)
   */
  private calculateModelAssignmentScore(dag: Dag): number {
    // Check if models are assigned where they should be
    let correctAssignments = 0;
    let totalAssignments = 0;

    for (const task of dag.tasks) {
      if (task.model) {
        totalAssignments++;

        // Check if model matches executor hint if present
        if (task.executor_hint) {
          const hint = task.executor_hint.toLowerCase();
          const model = task.model.toLowerCase();

          if (hint.includes('claude-code') && model.startsWith('cc/')) {
            correctAssignments++;
          } else if (hint.includes('codex') && model.startsWith('cx/')) {
            correctAssignments++;
          } else if (hint.includes('gemini') && model.startsWith('gemini-cli/')) {
            correctAssignments++;
          } else if (hint.includes('kimi') && model.startsWith('kimi-coding/')) {
            correctAssignments++;
          }
        } else {
          // No executor hint, model assignment should be reasonable for task kind
          correctAssignments++; // Can't validate without hint, assume correct
        }
      } else {
        // No model assigned - check if this is acceptable
        const kind = task.kind;
        const acceptableWithoutModel = ['llm_call', 'pal_call', 'tool_call', 'if_else', 'switch', 'extract_json', 'print', 'loop', 'merge', 'transform', 'evaluator'].includes(kind);

        if (acceptableWithoutModel || task.id === 't0') {
          correctAssignments++;
        }
        totalAssignments++;
      }
    }

    return totalAssignments > 0 ? correctAssignments / totalAssignments : 1.0;
  }

  /**
   * Calculate completeness score
   */
  private calculateCompleteness(dag: Dag, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check if expected number of tasks is met (within tolerance)
    if (expected.metadata?.expectedTaskCount) {
      checks++;
      const { minTasks, maxTasks } = this.taskCountBounds(expected.metadata.expectedTaskCount);

      if (dag.tasks.length >= minTasks && dag.tasks.length <= maxTasks) {
        score += 1;
      }
    }

    // Check if plan gate exists
    checks++;
    if (dag.tasks[0]?.id === 't0') {
      score += 1;
    }

    // Check if all tasks have kinds
    checks++;
    const tasksWithKinds = dag.tasks.filter(t => t.kind && t.kind.length > 0);
    if (tasksWithKinds.length === dag.tasks.length) {
      score += 1;
    }

    // Check if dependencies are valid
    checks++;
    try {
      const ids = new Set(dag.tasks.map(t => t.id));
      let validDeps = true;
      for (const task of dag.tasks) {
        for (const dep of task.depends_on) {
          if (!ids.has(dep)) {
            validDeps = false;
            break;
          }
        }
      }
      if (validDeps) {
        score += 1;
      }
    } catch {
      // Dependency validation failed
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Calculate correctness score
   */
  private calculateCorrectness(dag: Dag, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check if task complexity matches expected
    if (expected.metadata?.expectedGranularity) {
      checks++;
      const actualGranularity = this.getGranularityLevel(dag.tasks.length);
      const expectedGranularity = expected.metadata.expectedGranularity;

      if (this.granularityMatches(actualGranularity, expectedGranularity)) {
        score += 1;
      }
    }

    // Check if expected falsifiable criteria count is met
    if (expected.metadata?.expectedFalsifiableCriteria) {
      checks++;
      const actualFalsifiable = dag.tasks.filter(t =>
        t.id !== 't0' && isFalsifiableCriteria(t.acceptance_criteria)
      ).length;

      const expectedFalsifiable = expected.metadata.expectedFalsifiableCriteria;
      if (actualFalsifiable >= expectedFalsifiable * 0.8) { // 80% threshold
        score += 1;
      }
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Determine granularity level from task count
   */
  private getGranularityLevel(taskCount: number): string {
    if (taskCount <= 3) return 'coarse-grained';
    if (taskCount <= 7) return 'fine-grained';
    return 'over-granular';
  }

  /**
   * Check if granularity levels match
   */
  private granularityMatches(actual: string, expected: string): boolean {
    if (actual === expected) return true;
    if (actual === 'fine-grained' && expected === 'medium-grained') return true;
    if (actual === 'medium-grained' && expected === 'fine-grained') return true;
    return false;
  }

}