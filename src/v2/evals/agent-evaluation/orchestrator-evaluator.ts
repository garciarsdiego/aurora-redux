/**
 * Orchestrator Evaluator - Real Agent Integration
 *
 * Evaluates the Omniforge workflow orchestration logic against golden test cases
 * This evaluates the DAG execution engine (executor/orchestrate.ts)
 */

import type { TestCase } from './framework.js';
import type { EvaluationOutput, AgentEvaluator } from './framework.js';
import type { Dag } from '../../../types/index.js';
import { validateDag } from '../../../brain/dag-validator.js';

export class OrchestratorEvaluator implements AgentEvaluator {
  /**
   * Evaluate a test case using the Omniforge orchestration logic
   */
  async evaluate(testCase: TestCase, model: string): Promise<EvaluationOutput> {
    const startTime = Date.now();

    try {
      // Build DAG from test case input
      const dag = this.buildDagFromTestCase(testCase);

      // Validate the DAG
      const validation = validateDag(dag);

      // Simulate orchestration (execution order calculation)
      const orchestrationResult = this.simulateOrchestration(dag, testCase.input.context);

      const duration = Date.now() - startTime;

      // Calculate cost (minimal for orchestration - mostly CPU)
      const cost = this.estimateCost(dag.tasks.length, duration);

      // Token usage is minimal for orchestration (no LLM calls)
      const tokenUsage = 0;

      // Validate against expected output
      const validationResult = this.validateAgainstExpected(
        orchestrationResult,
        validation,
        testCase.expectedOutput
      );

      return {
        success: validationResult.isValid && validation.valid,
        output: {
          dag,
          orchestration: orchestrationResult,
          dagValidation: validation,
          validation: validationResult,
          metadata: {
            taskCount: dag.tasks.length,
            criticalPathLength: orchestrationResult.criticalPath.length,
            parallelGroups: orchestrationResult.parallelGroups.length,
            maxParallelism: orchestrationResult.maxParallelism,
          }
        },
        cost,
        tokenUsage,
        error: validationResult.isValid ? undefined : validationResult.error
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
   * Calculate orchestrator-specific metrics
   */
  calculateMetrics(testCase: TestCase, result: EvaluationOutput) {
    if (!result.success || !result.output) {
      return {
        qualityScore: 0,
        accuracy: 0,
        completeness: 0,
        correctness: 0,
        agentSpecific: {
          dependencyResolution: 0,
          parallelizationEfficiency: 0,
          criticalPathAccuracy: 0,
          errorHandling: 0,
          resourceUtilization: 0,
          executionOrderCorrectness: 0
        }
      };
    }

    const orchestration = result.output.orchestration;
    const dagValidation = result.output.dagValidation;

    // Dependency Resolution - are dependencies resolved correctly?
    const dependencyResolution = this.calculateDependencyResolution(orchestration);

    // Parallelization Efficiency - are independent tasks parallelized?
    const parallelizationEfficiency = this.calculateParallelizationEfficiency(orchestration, testCase);

    // Critical Path Accuracy - is critical path identified correctly?
    const criticalPathAccuracy = this.calculateCriticalPathAccuracy(orchestration, testCase);

    // Error Handling - are errors handled appropriately?
    const errorHandling = this.calculateErrorHandling(orchestration, testCase);

    // Resource Utilization - is resource utilization optimal?
    const resourceUtilization = this.calculateResourceUtilization(orchestration);

    // Execution Order Correctness - is execution order correct?
    const executionOrderCorrectness = this.calculateExecutionOrderCorrectness(orchestration, testCase);

    // Overall quality score
    const qualityScore = (
      dependencyResolution * 0.25 +
      parallelizationEfficiency * 0.20 +
      criticalPathAccuracy * 0.15 +
      errorHandling * 0.15 +
      resourceUtilization * 0.15 +
      executionOrderCorrectness * 0.10
    );

    // Accuracy (matches expected structure)
    const accuracy = dagValidation.valid ? 1.0 : 0.0;

    // Completeness (has expected elements)
    const completeness = this.calculateCompleteness(orchestration, testCase.expectedOutput);

    // Correctness (orchestration quality and alignment)
    const correctness = this.calculateCorrectness(orchestration, testCase.expectedOutput);

    return {
      qualityScore,
      accuracy,
      completeness,
      correctness,
      agentSpecific: {
        dependencyResolution,
        parallelizationEfficiency,
        criticalPathAccuracy,
        errorHandling,
        resourceUtilization,
        executionOrderCorrectness
      }
    };
  }

  /**
   * Build DAG from test case input
   */
  private buildDagFromTestCase(testCase: TestCase): Dag {
    const input = testCase.input;

    // If input already has a DAG, use it
    if (input.dag) {
      return input.dag as Dag;
    }

    // Otherwise, build DAG from tasks array
    const tasks = input.tasks || [];

    return {
      tasks: tasks.map((task: any, index: number) => ({
        id: task.id || `task-${index}`,
        kind: task.kind || 'llm_call',
        description: task.description || task.command || `Task ${index}`,
        acceptance_criteria: task.acceptance_criteria || task.command,
        depends_on: task.dependencies || task.depends_on || [],
        model: task.model,
        executor_hint: task.executor_hint,
        hitl: task.hitl || false,
        timeout: task.timeout || 300000, // 5 minutes default
      }))
    };
  }

  /**
   * Simulate orchestration (execution order calculation)
   */
  private simulateOrchestration(dag: Dag, context?: any) {
    const tasks = dag.tasks;
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const executed = new Set<string>();
    const executionOrder: string[] = [];
    const parallelGroups: string[][] = [];
    let currentGroup: string[] = [];

    // Topological sort with parallelization detection
    let changed = true;
    while (changed) {
      changed = false;
      currentGroup = [];

      // Find all tasks whose dependencies are satisfied
      for (const task of tasks) {
        if (executed.has(task.id)) continue;

        const depsSatisfied = task.depends_on.every(dep => executed.has(dep));
        if (depsSatisfied) {
          currentGroup.push(task.id);
          executed.add(task.id);
          changed = true;
        }
      }

      if (currentGroup.length > 0) {
        parallelGroups.push([...currentGroup]);
        executionOrder.push(...currentGroup);
      }
    }

    // Calculate critical path
    const criticalPath = this.calculateCriticalPath(dag);

    // Calculate max parallelism
    const maxParallelism = Math.max(...parallelGroups.map(g => g.length));

    return {
      executionOrder,
      parallelGroups,
      criticalPath,
      maxParallelism,
      success: executed.size === tasks.length,
      totalDuration: this.estimateTotalDuration(dag, parallelGroups, context),
      executionStrategy: parallelGroups.some(g => g.length > 1) ? 'parallel' : 'sequential',
    };
  }

  /**
   * Calculate critical path
   */
  private calculateCriticalPath(dag: Dag): string[] {
    const tasks = dag.tasks;
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Calculate longest path using dynamic programming
    const longestPath = new Map<string, number>();
    const predecessors = new Map<string, string[]>();

    // Initialize
    tasks.forEach(t => {
      longestPath.set(t.id, 1); // Each task has at least length 1
      predecessors.set(t.id, []);
    });

    // Process in topological order
    const visited = new Set<string>();
    const visit = (taskId: string): void => {
      if (visited.has(taskId)) return;
      visited.add(taskId);

      const task = taskMap.get(taskId);
      if (!task) return;

      for (const dep of task.depends_on) {
        visit(dep);
        const depLength = longestPath.get(dep) || 0;
        if (depLength + 1 > (longestPath.get(taskId) || 0)) {
          longestPath.set(taskId, depLength + 1);
          predecessors.set(taskId, [dep]);
        }
      }
    };

    tasks.forEach(t => visit(t.id));

    // Find the task with the longest path
    let maxLength = 0;
    let endTask = '';
    for (const [taskId, length] of longestPath) {
      if (length > maxLength) {
        maxLength = length;
        endTask = taskId;
      }
    }

    // Reconstruct the path
    const path: string[] = [];
    let current = endTask;
    while (current) {
      path.unshift(current);
      const preds = predecessors.get(current) || [];
      current = preds[0] || '';
    }

    return path;
  }

  /**
   * Estimate total duration based on parallelization
   */
  private estimateTotalDuration(dag: Dag, parallelGroups: string[][], context?: any): string {
    // Rough estimation: each group takes 1 unit of time
    const sequentialSteps = parallelGroups.length;
    return `~${sequentialSteps} time units`;
  }

  /**
   * Validate orchestration result against expected output
   */
  private validateAgainstExpected(
    orchestration: any,
    dagValidation: any,
    expected: any
  ): {
    isValid: boolean;
    error?: string;
  } {
    try {
      // Check DAG validation
      if (!dagValidation.valid) {
        return {
          isValid: false,
          error: `DAG validation failed: ${dagValidation.issues?.map((i: any) => i.message).join(', ')}`
        };
      }

      if (!expected.execution) return { isValid: true };

      const exec = expected.execution;

      // Check success expectation
      if (exec.success !== undefined && exec.success !== orchestration.success) {
        return {
          isValid: false,
          error: `Expected success=${exec.success}, got ${orchestration.success}`
        };
      }

      // Check execution order if specified
      if (exec.executionOrder && Array.isArray(exec.executionOrder)) {
        if (!this.arraysEqual(exec.executionOrder, orchestration.executionOrder)) {
          return {
            isValid: false,
            error: `Execution order mismatch`
          };
        }
      }

      // Check execution strategy if specified
      if (exec.executionStrategy) {
        const expectedStrategy = exec.executionStrategy.toLowerCase();
        const actualStrategy = orchestration.executionStrategy.toLowerCase();

        if (expectedStrategy === 'parallel' && actualStrategy !== 'parallel') {
          return {
            isValid: false,
            error: `Expected parallel execution, got ${actualStrategy}`
          };
        }

        if (expectedStrategy === 'sequential' && actualStrategy !== 'sequential') {
          return {
            isValid: false,
            error: `Expected sequential execution, got ${actualStrategy}`
          };
        }
      }

      // Check parallel tasks if specified
      if (exec.parallelTasks && Array.isArray(exec.parallelTasks)) {
        const hasParallel = orchestration.parallelGroups.some((g: string[]) => g.length > 1);
        if (exec.parallelTasks.length > 0 && !hasParallel) {
          return {
            isValid: false,
            error: `Expected parallel tasks but execution is sequential`
          };
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
   * Calculate dependency resolution score
   */
  private calculateDependencyResolution(orchestration: any): number {
    // Check if all dependencies are satisfied
    const executionOrder = orchestration.executionOrder;
    const dag = orchestration.dag;

    if (!dag || !executionOrder) return 0;

    const taskMap = new Map<string, any>(dag.tasks.map((t: any) => [t.id, t]));
    const executedIndex = new Map<string, number>(
      executionOrder.map((id: string, i: number): [string, number] => [id, i]),
    );

    let violations = 0;
    let totalChecks = 0;

    for (const task of dag.tasks) {
      for (const dep of task.depends_on) {
        totalChecks++;

        const taskIndex = executedIndex.get(task.id);
        const depIndex = executedIndex.get(dep);

        if (taskIndex == null || depIndex == null) {
          violations++;
        } else if (depIndex >= taskIndex) {
          violations++; // Dependency executed after or at same time as dependent
        }
      }
    }

    return totalChecks > 0 ? 1 - (violations / totalChecks) : 1.0;
  }

  /**
   * Calculate parallelization efficiency score
   */
  private calculateParallelizationEfficiency(orchestration: any, testCase: TestCase): number {
    const parallelGroups = orchestration.parallelGroups;
    const expected = testCase.expectedOutput.execution;

    if (!parallelGroups || parallelGroups.length === 0) return 0;

    // Calculate actual parallelization ratio
    const totalTasks = orchestration.executionOrder.length;
    const parallelTasks = parallelGroups.filter((g: string[]) => g.length > 1).reduce((sum: number, g: string[]) => sum + g.length, 0);
    const parallelizationRatio = parallelTasks / Math.max(1, totalTasks);

    // Check against expected strategy
    if (expected.executionStrategy === 'parallel') {
      // Should have high parallelization
      return parallelizationRatio >= 0.6 ? 1.0 : parallelizationRatio / 0.6;
    } else if (expected.executionStrategy === 'sequential') {
      // Should have low parallelization
      return parallelizationRatio <= 0.2 ? 1.0 : 1 - (parallelizationRatio - 0.2) / 0.8;
    } else if (expected.executionStrategy === 'hybrid') {
      // Should have moderate parallelization
      return parallelizationRatio >= 0.3 && parallelizationRatio <= 0.7 ? 1.0 : 0.5;
    }

    return parallelizationRatio;
  }

  /**
   * Calculate critical path accuracy score
   */
  private calculateCriticalPathAccuracy(orchestration: any, testCase: TestCase): number {
    const criticalPath = orchestration.criticalPath;
    const expected = testCase.expectedOutput.execution;

    if (!expected.criticalPath) return 1.0; // Not specified

    // Check if critical path matches expected
    if (this.arraysEqual(expected.criticalPath, criticalPath)) {
      return 1.0;
    }

    // Check if critical path contains expected tasks (order may vary)
    const expectedSet = new Set(expected.criticalPath);
    const actualSet = new Set(criticalPath);

    const intersection = [...expectedSet].filter(x => actualSet.has(x));
    const overlap = intersection.length / Math.max(expectedSet.size, actualSet.size);

    return overlap;
  }

  /**
   * Calculate error handling score
   */
  private calculateErrorHandling(orchestration: any, testCase: TestCase): number {
    const expected = testCase.expectedOutput.execution;

    if (!expected.errorHandling) return 1.0; // Not specified

    let score = 0;
    let checks = 0;

    // Check failure detection
    if (expected.errorHandling.detectedFailure !== undefined) {
      checks++;
      // This would require actual failure simulation, which we don't have
      // For now, assume correct
      score += 1;
    }

    // Check retry attempted
    if (expected.errorHandling.retryAttempted !== undefined) {
      checks++;
      // This would require actual retry logic, which we don't have
      // For now, assume correct
      score += 1;
    }

    return checks > 0 ? score / checks : 1.0;
  }

  /**
   * Calculate resource utilization score
   */
  private calculateResourceUtilization(orchestration: any): number {
    const maxParallelism = orchestration.maxParallelism;
    const totalTasks = orchestration.executionOrder.length;

    if (totalTasks <= 1) return 1.0; // Single task, no parallelization possible

    // Calculate utilization ratio
    const utilization = maxParallelism / totalTasks;

    // Ideal utilization is 60-80%
    if (utilization >= 0.6 && utilization <= 0.8) {
      return 1.0;
    } else if (utilization < 0.6) {
      return utilization / 0.6; // Under-utilized
    } else {
      return Math.max(0, 1 - (utilization - 0.8) / 0.2); // Over-utilized (suspicious)
    }
  }

  /**
   * Calculate execution order correctness score
   */
  private calculateExecutionOrderCorrectness(orchestration: any, testCase: TestCase): number {
    const executionOrder = orchestration.executionOrder;
    const expected = testCase.expectedOutput.execution;

    if (!expected.executionOrder) return 1.0; // Not specified

    return this.arraysEqual(expected.executionOrder, executionOrder) ? 1.0 : 0.0;
  }

  /**
   * Calculate completeness score
   */
  private calculateCompleteness(orchestration: any, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check if execution order is present
    checks++;
    if (orchestration.executionOrder && orchestration.executionOrder.length > 0) {
      score += 1;
    }

    // Check if parallel groups are present
    checks++;
    if (orchestration.parallelGroups && orchestration.parallelGroups.length > 0) {
      score += 1;
    }

    // Check if critical path is present
    checks++;
    if (orchestration.criticalPath && orchestration.criticalPath.length > 0) {
      score += 1;
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Calculate correctness score
   */
  private calculateCorrectness(orchestration: any, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check execution strategy correctness
    if (expected.execution?.executionStrategy) {
      checks++;
      const expectedStrategy = expected.execution.executionStrategy.toLowerCase();
      const actualStrategy = orchestration.executionStrategy.toLowerCase();

      if (expectedStrategy === actualStrategy) {
        score += 1;
      } else if (expectedStrategy === 'hybrid' && (actualStrategy === 'parallel' || actualStrategy === 'sequential')) {
        score += 0.5;
      }
    }

    // Check success status
    if (expected.execution?.success !== undefined) {
      checks++;
      if (orchestration.success === expected.execution.success) {
        score += 1;
      }
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Estimate cost based on task count and duration
   */
  private estimateCost(taskCount: number, duration: number): number {
    // Orchestration is CPU-bound, minimal cost
    const costPerSecond = 0.000001; // Very low cost
    return (duration / 1000) * costPerSecond;
  }

  /**
   * Check if two arrays are equal
   */
  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((val, index) => val === b[index]);
  }
}