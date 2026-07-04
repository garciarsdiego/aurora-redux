/**
 * Planner Evaluator - Real Agent Integration
 *
 * Evaluates the Omniforge planner advisor against golden test cases
 */

import type { TestCase } from './framework.js';
import type { EvaluationOutput, AgentEvaluator } from './framework.js';
import { plannerAdvisor } from '../../advisors/planner/handler.js';
import type { PlannerInput } from '../../advisors/planner/schema.js';

export class PlannerEvaluator implements AgentEvaluator {
  /**
   * Evaluate a test case using the real Omniforge planner advisor
   */
  async evaluate(testCase: TestCase, model: string): Promise<EvaluationOutput> {
    const startTime = Date.now();

    try {
      // Build planner input from test case
      const plannerInput: PlannerInput = this.buildPlannerInput(testCase, model);

      // Create minimal advisor context
      const ctx = {
        workspace: testCase.input.context?.workspace || process.cwd(),
        workflow_id: testCase.input.workflow_id || 'eval-planner-workflow',
      };

      // Call the real planner advisor
      const result = await plannerAdvisor.run(ctx, plannerInput);

      const duration = Date.now() - startTime;

      // Calculate cost (rough estimation based on model tier)
      const cost = this.estimateCost(model, duration);

      // Calculate token usage (rough estimation)
      const tokenUsage = this.estimateTokens(model, testCase.complexity);

      // Validate against expected output
      const validation = this.validateAgainstExpected(result.output, testCase.expectedOutput);

      const nextStep = 'nextStep' in result ? result.nextStep : undefined;

      return {
        success: validation.isValid,
        output: {
          plan: result.output,
          nextStep,
          validation,
          metadata: {
            stepNumber: plannerInput.step_number,
            totalSteps: plannerInput.total_steps,
            hasNextStep: !!nextStep,
          }
        },
        cost,
        tokenUsage,
        error: validation.isValid ? undefined : validation.error
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;

      return {
        success: false,
        output: null,
        cost: 0,
        tokenUsage: 0,
        error: error.message
      };
    }
  }

  /**
   * Calculate planner-specific metrics
   */
  calculateMetrics(testCase: TestCase, result: EvaluationOutput) {
    if (!result.success || !result.output) {
      return {
        qualityScore: 0,
        accuracy: 0,
        completeness: 0,
        correctness: 0,
        agentSpecific: {
          stepQuality: 0,
          coverage: 0,
          coherence: 0,
          actionability: 0,
          contextAwareness: 0,
          revisionHandling: 0,
          branchHandling: 0
        }
      };
    }

    const plan = result.output.plan as string;
    const validation = result.output.validation;

    // Step Quality - measures clarity and completeness of individual steps
    const stepQuality = this.calculateStepQuality(plan, testCase);

    // Coverage - measures how well the plan covers the objective
    const coverage = this.calculateCoverage(plan, testCase.expectedOutput);

    // Coherence - measures logical flow between steps
    const coherence = this.calculateCoherence(plan, testCase);

    // Actionability - measures how actionable the plan is
    const actionability = this.calculateActionability(plan);

    // Context Awareness - measures how well the plan uses context
    const contextAwareness = this.calculateContextAwareness(plan, testCase);

    // Revision Handling - measures how well revisions are handled
    const revisionHandling = this.calculateRevisionHandling(plan, testCase);

    // Branch Handling - measures how well branching is handled
    const branchHandling = this.calculateBranchHandling(plan, testCase);

    // Overall quality score
    const qualityScore = (
      stepQuality * 0.25 +
      coverage * 0.20 +
      coherence * 0.15 +
      actionability * 0.15 +
      contextAwareness * 0.10 +
      revisionHandling * 0.08 +
      branchHandling * 0.07
    );

    // Accuracy (matches expected structure)
    const accuracy = validation.isValid ? 1.0 : 0.0;

    // Completeness (has expected elements)
    const completeness = this.calculateCompleteness(plan, testCase.expectedOutput);

    // Correctness (plan quality and execution feasibility)
    const correctness = this.calculateCorrectness(plan, testCase.expectedOutput);

    return {
      qualityScore,
      accuracy,
      completeness,
      correctness,
      agentSpecific: {
        stepQuality,
        coverage,
        coherence,
        actionability,
        contextAwareness,
        revisionHandling,
        branchHandling
      }
    };
  }

  /**
   * Build planner input from test case
   */
  private buildPlannerInput(testCase: TestCase, model: string): PlannerInput {
    const input = testCase.input;

    return {
      step: input.step || input.objective || testCase.description,
      step_number: input.step_number || 1,
      total_steps: input.total_steps || 1,
      next_step_required: input.next_step_required !== undefined ? input.next_step_required : false,
      is_step_revision: input.is_step_revision || false,
      revises_step_number: input.revises_step_number,
      is_branch_point: input.is_branch_point || false,
      branch_from_step: input.branch_from_step,
      branch_id: input.branch_id,
      more_steps_needed: input.more_steps_needed || false,
    };
  }

  /**
   * Validate planner output against expected output
   */
  private validateAgainstExpected(plan: string, expected: any): {
    isValid: boolean;
    error?: string;
  } {
    try {
      // Check if plan is non-empty
      if (!plan || plan.trim().length === 0) {
        return {
          isValid: false,
          error: 'Plan is empty'
        };
      }

      // Check if expected structure is met
      if (expected.execution) {
        const exec = expected.execution;

        // Check success expectation
        if (exec.success !== undefined && !exec.success) {
          // Test expects failure, but we should still validate structure
        }

        // Check execution order if specified
        if (exec.executionOrder && Array.isArray(exec.executionOrder)) {
          const steps = plan.split(/\n+/).filter(s => s.trim().length > 0);
          if (steps.length === 0) {
            return {
              isValid: false,
              error: 'No steps found in plan'
            };
          }
        }

        // Check execution strategy if specified
        if (exec.executionStrategy) {
          const strategy = exec.executionStrategy.toLowerCase();
          const planLower = plan.toLowerCase();

          if (strategy === 'parallel' && !planLower.includes('parallel')) {
            return {
              isValid: false,
              error: 'Plan should mention parallel execution'
            };
          }

          if (strategy === 'sequential' && !planLower.includes('sequential')) {
            return {
              isValid: false,
              error: 'Plan should mention sequential execution'
            };
          }
        }
      }

      return { isValid: true };

    } catch (error: any) {
      return {
        isValid: false,
        error: `Validation error: ${error.message}`
      };
    }
  }

  /**
   * Calculate step quality score
   */
  private calculateStepQuality(plan: string, testCase: TestCase): number {
    const steps = plan.split(/\n+/).filter(s => s.trim().length > 0);

    if (steps.length === 0) return 0;

    // Check for clear action verbs
    const actionVerbs = ['implement', 'create', 'build', 'add', 'setup', 'configure', 'deploy', 'test', 'verify'];
    const stepsWithActions = steps.filter(s =>
      actionVerbs.some(verb => s.toLowerCase().includes(verb))
    );

    const actionScore = stepsWithActions.length / Math.max(1, steps.length);

    // Check for specific, measurable outcomes
    const measurablePatterns = ['should', 'must', 'ensure', 'verify', 'check'];
    const stepsWithMeasurable = steps.filter(s =>
      measurablePatterns.some(pattern => s.toLowerCase().includes(pattern))
    );

    const measurableScore = stepsWithMeasurable.length / Math.max(1, steps.length);

    return (actionScore + measurableScore) / 2;
  }

  /**
   * Calculate coverage score
   */
  private calculateCoverage(plan: string, expected: any): number {
    if (!expected.execution) return 1.0;

    const planLower = plan.toLowerCase();

    let coverage = 0;
    let checks = 0;

    // Check for key concepts from expected output
    if (expected.execution.executionStrategy) {
      checks++;
      const strategy = expected.execution.executionStrategy.toLowerCase();
      if (planLower.includes(strategy)) {
        coverage += 1;
      }
    }

    if (expected.execution.parallelTasks) {
      checks++;
      const hasParallel = expected.execution.parallelTasks.length > 0;
      if (hasParallel && planLower.includes('parallel')) {
        coverage += 1;
      } else if (!hasParallel) {
        coverage += 1;
      }
    }

    if (expected.execution.errorHandling) {
      checks++;
      if (planLower.includes('error') || planLower.includes('fail') || planLower.includes('retry')) {
        coverage += 1;
      }
    }

    return checks > 0 ? coverage / checks : 1.0;
  }

  /**
   * Calculate coherence score
   */
  private calculateCoherence(plan: string, testCase: TestCase): number {
    const lines = plan.split(/\n+/).filter(s => s.trim().length > 0);

    if (lines.length < 2) return 1.0;

    // Check for logical connectors
    const connectors = ['then', 'next', 'after', 'followed by', 'subsequently', 'finally'];
    let connectorCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (connectors.some(c => line.includes(c))) {
        connectorCount++;
      }
    }

    return connectorCount / (lines.length - 1);
  }

  /**
   * Calculate actionability score
   */
  private calculateActionability(plan: string): number {
    const lines = plan.split(/\n+/).filter(s => s.trim().length > 0);

    if (lines.length === 0) return 0;

    // Check for actionable language
    const actionablePatterns = [
      /^\s*\d+[\.)]\s*/,  // Numbered lists
      /^\s*[-*•]\s+/,     // Bullet points
      /\b(install|run|execute|build|test|deploy|create|add|configure)\s+\w+/i
    ];

    const actionableLines = lines.filter(line =>
      actionablePatterns.some(pattern => pattern.test(line))
    );

    return actionableLines.length / lines.length;
  }

  /**
   * Calculate context awareness score
   */
  private calculateContextAwareness(plan: string, testCase: TestCase): number {
    const planLower = plan.toLowerCase();
    const context = testCase.input.context || {};

    let awareness = 0;
    let checks = 0;

    // Check for workspace awareness
    if (context.workspace) {
      checks++;
      if (planLower.includes('workspace') || planLower.includes('project') || planLower.includes('directory')) {
        awareness += 1;
      }
    }

    // Check for timeout awareness
    if (context.timeout) {
      checks++;
      if (planLower.includes('time') || planLower.includes('timeout') || planLower.includes('duration')) {
        awareness += 1;
      }
    }

    // Check for optimization awareness
    if (context.optimization) {
      checks++;
      if (planLower.includes('optimization') || planLower.includes('optimize') || planLower.includes('parallel')) {
        awareness += 1;
      }
    }

    return checks > 0 ? awareness / checks : 1.0;
  }

  /**
   * Calculate revision handling score
   */
  private calculateRevisionHandling(plan: string, testCase: TestCase): number {
    const input = testCase.input;

    if (!input.is_step_revision) return 1.0; // Not applicable

    const planLower = plan.toLowerCase();

    // Check if revision is acknowledged
    if (planLower.includes('revision') || planLower.includes('revised') || planLower.includes('updated')) {
      return 1.0;
    }

    return 0.5;
  }

  /**
   * Calculate branch handling score
   */
  private calculateBranchHandling(plan: string, testCase: TestCase): number {
    const input = testCase.input;

    if (!input.is_branch_point) return 1.0; // Not applicable

    const planLower = plan.toLowerCase();

    // Check if branch is acknowledged
    if (planLower.includes('branch') || planLower.includes('alternative') || planLower.includes('path')) {
      return 1.0;
    }

    return 0.5;
  }

  /**
   * Calculate completeness score
   */
  private calculateCompleteness(plan: string, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check if plan is non-empty
    checks++;
    if (plan && plan.trim().length > 0) {
      score += 1;
    }

    // Check if plan has structure
    checks++;
    const lines = plan.split(/\n+/).filter(s => s.trim().length > 0);
    if (lines.length > 0) {
      score += 1;
    }

    // Check if expected execution strategy is mentioned
    if (expected.execution?.executionStrategy) {
      checks++;
      const planLower = plan.toLowerCase();
      if (planLower.includes(expected.execution.executionStrategy.toLowerCase())) {
        score += 1;
      }
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Calculate correctness score
   */
  private calculateCorrectness(plan: string, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check execution strategy correctness
    if (expected.execution?.executionStrategy) {
      checks++;
      const planLower = plan.toLowerCase();
      const strategy = expected.execution.executionStrategy.toLowerCase();

      if (strategy === 'parallel' && planLower.includes('parallel')) {
        score += 1;
      } else if (strategy === 'sequential' && !planLower.includes('parallel')) {
        score += 1;
      } else if (strategy === 'hybrid' && (planLower.includes('parallel') && planLower.includes('sequential'))) {
        score += 1;
      }
    }

    // Check error handling if expected
    if (expected.execution?.errorHandling) {
      checks++;
      const planLower = plan.toLowerCase();
      if (planLower.includes('error') || planLower.includes('fail') || planLower.includes('retry')) {
        score += 1;
      }
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Estimate cost based on model and duration
   */
  private estimateCost(model: string, duration: number): number {
    const tier = this.getModelTier(model);

    const costPerSecond = {
      premium: 0.0001,
      balanced: 0.00005,
      cost: 0.00001,
      alternative: 0.000008
    };

    const rate = costPerSecond[tier] || 0.00005;
    return (duration / 1000) * rate;
  }

  /**
   * Estimate token usage based on model and complexity
   */
  private estimateTokens(model: string, complexity: string): number {
    const complexityMultiplier = {
      simple: 1.0,
      medium: 2.0,
      complex: 4.0
    };

    const baseTokens = 1000;
    return baseTokens * complexityMultiplier[complexity as keyof typeof complexityMultiplier];
  }

  /**
   * Get model tier for cost estimation
   */
  private getModelTier(model: string): 'premium' | 'balanced' | 'cost' | 'alternative' {
    if (model.includes('claude-opus') || model.includes('gpt-5.5')) return 'premium';
    if (model.includes('claude-sonnet') || model.includes('kimi') || model.includes('opencode')) return 'balanced';
    if (model.includes('gemini') || model.includes('deepseek') || model.includes('minimax')) return 'cost';
    return 'alternative';
  }
}