/**
 * Reviewer Evaluator - Real Agent Integration
 *
 * Evaluates the Omniforge reviewer persona against golden test cases
 */

import type { TestCase } from './framework.js';
import type { EvaluationOutput, AgentEvaluator } from './framework.js';
import { REVIEWER_PERSONA, type ReviewerInput, type ReviewerOutput } from '../../agents/personas/reviewer.js';
import { runAgent, type AgentInvoker, createInMemoryContext } from '../../agents/runner.js';
import { callOmniroute } from '../../../utils/omniroute-call.js';
import { getModelTier, COST_PER_SECOND, COMPLEXITY_MULTIPLIER } from './cost-estimation.js';

export class ReviewerEvaluator implements AgentEvaluator {
  /**
   * Evaluate a test case using the real Omniforge reviewer persona
   */
  async evaluate(testCase: TestCase, model: string): Promise<EvaluationOutput> {
    const startTime = Date.now();

    try {
      // Build reviewer input from test case
      const reviewerInput = this.buildReviewerInput(testCase, model);

      // Create minimal agent context
      const ctx = createInMemoryContext({
        workspaceDir: testCase.input.context?.workspace || process.cwd(),
        workflowId: testCase.input.workflow_id || 'test-workflow-001',
        taskId: testCase.input.task_id || 'test-task-001',
      });

      // Create invoker for Omniroute
      const invoker: AgentInvoker = async (args) => {
        return await callOmniroute({
          systemPrompt: args.systemPrompt,
          userPrompt: args.userPrompt || 'Respond per the system contract above. No preamble, no markdown fences.',
          model: args.model,
        });
      };

      // Call the real reviewer persona
      const output = await runAgent(
        REVIEWER_PERSONA,
        reviewerInput,
        ctx,
        {
          invoke: invoker,
          modelOverride: model,
          parseJson: true,
        }
      );

      const duration = Date.now() - startTime;

      // Calculate cost (rough estimation based on model tier)
      const cost = this.estimateCost(model, duration, output.llm_called);

      // Calculate token usage (rough estimation)
      const tokenUsage = this.estimateTokens(model, testCase.complexity, output.llm_called);

      // Validate against expected output
      const validation = this.validateAgainstExpected(output, testCase.expectedOutput);

      return {
        success: validation.isValid,
        output: {
          review: output,
          validation,
          metadata: {
            verdict: output.verdict,
            llmCalled: output.llm_called,
            evidenceCount: output.evidence.length,
            suspicionScore: output.suspicion_score,
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
   * Calculate reviewer-specific metrics
   */
  calculateMetrics(testCase: TestCase, result: EvaluationOutput) {
    if (!result.success || !result.output) {
      return {
        qualityScore: 0,
        accuracy: 0,
        completeness: 0,
        correctness: 0,
        agentSpecific: {
          verdictAccuracy: 0,
          evidenceQuality: 0,
          feedbackActionability: 0,
          filesystemVerification: 0,
          suspicionHandling: 0,
          softFailUsage: 0,
          criteriaCoverage: 0
        }
      };
    }

    const review = result.output.review as ReviewerOutput;
    const validation = result.output.validation;

    // Verdict Accuracy - does the verdict match expectations?
    const verdictAccuracy = this.calculateVerdictAccuracy(review, testCase.expectedOutput);

    // Evidence Quality - are evidence entries complete and specific?
    const evidenceQuality = this.calculateEvidenceQuality(review, testCase);

    // Feedback Actionability - is the feedback actionable?
    const feedbackActionability = this.calculateFeedbackActionability(review);

    // Filesystem Verification - was filesystem used for verification?
    const filesystemVerification = this.calculateFilesystemVerification(review);

    // Suspicion Handling - are suspicion patterns handled correctly?
    const suspicionHandling = this.calculateSuspicionHandling(review);

    // Soft Fail Usage - is soft_fail used appropriately?
    const softFailUsage = this.calculateSoftFailUsage(review, testCase);

    // Criteria Coverage - are all acceptance criteria covered?
    const criteriaCoverage = this.calculateCriteriaCoverage(review, testCase);

    // Overall quality score
    const qualityScore = (
      verdictAccuracy * 0.25 +
      evidenceQuality * 0.20 +
      feedbackActionability * 0.15 +
      filesystemVerification * 0.15 +
      suspicionHandling * 0.10 +
      softFailUsage * 0.08 +
      criteriaCoverage * 0.07
    );

    // Accuracy (matches expected structure)
    const accuracy = validation.isValid ? 1.0 : 0.0;

    // Completeness (has expected elements)
    const completeness = this.calculateCompleteness(review, testCase.expectedOutput);

    // Correctness (review quality and alignment)
    const correctness = this.calculateCorrectness(review, testCase.expectedOutput);

    return {
      qualityScore,
      accuracy,
      completeness,
      correctness,
      agentSpecific: {
        verdictAccuracy,
        evidenceQuality,
        feedbackActionability,
        filesystemVerification,
        suspicionHandling,
        softFailUsage,
        criteriaCoverage
      }
    };
  }

  /**
   * Build reviewer input from test case
   */
  private buildReviewerInput(testCase: TestCase, model: string): ReviewerInput {
    const input = testCase.input;

    return {
      task_id: input.task_id || 'test-task-001',
      workflow_id: input.workflow_id || 'test-workflow-001',
      task_kind: input.task_kind || 'llm_call',
      acceptance_criteria: input.acceptance_criteria || testCase.description,
      worker_output: input.worker_output || input.output || {},
      workspace_dir: input.workspace_dir || testCase.input.context?.workspace || process.cwd(),
      files_claimed_written: input.files_claimed_written || [],
      tool_calls_trace: input.tool_calls_trace || [],
      filesystem_evidence: input.filesystem_evidence || [],
      filesystem_check_summary: input.filesystem_check_summary || {
        files_verified: [],
        files_missing: [],
        files_too_short: []
      },
      output_key: input.output_key,
      shared_state: input.shared_state || {},
      state_schema_violations: input.state_schema_violations || [],
      workflow_mode: input.workflow_mode || 'standard',
      architecture_contract: input.architecture_contract || null,
    };
  }

  /**
   * Validate reviewer output against expected output
   */
  private validateAgainstExpected(review: ReviewerOutput, expected: any): {
    isValid: boolean;
    error?: string;
  } {
    try {
      // Check if verdict is valid
      const validVerdicts = ['pass', 'fail', 'refine', 'soft_fail'];
      if (!validVerdicts.includes(review.verdict)) {
        return {
          isValid: false,
          error: `Invalid verdict: ${review.verdict}`
        };
      }

      // Check if feedback is non-empty
      if (!review.feedback || review.feedback.trim().length === 0) {
        return {
          isValid: false,
          error: 'Feedback is empty'
        };
      }

      // Check if evidence is provided
      if (!review.evidence || review.evidence.length === 0) {
        return {
          isValid: false,
          error: 'No evidence provided'
        };
      }

      // Check expected verdict if specified
      if (expected.verdict && expected.verdict !== review.verdict) {
        return {
          isValid: false,
          error: `Expected verdict ${expected.verdict}, got ${review.verdict}`
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
   * Calculate verdict accuracy score
   */
  private calculateVerdictAccuracy(review: ReviewerOutput, expected: any): number {
    if (!expected.verdict) return 1.0; // Not specified, assume correct

    return review.verdict === expected.verdict ? 1.0 : 0.0;
  }

  /**
   * Calculate evidence quality score
   */
  private calculateEvidenceQuality(review: ReviewerOutput, testCase: TestCase): number {
    if (review.evidence.length === 0) return 0;

    let quality = 0;
    let checks = 0;

    // Check if each evidence has required fields
    for (const evidence of review.evidence) {
      checks++;

      // Has criterion
      if (evidence.criterion && evidence.criterion.trim().length > 0) {
        quality += 0.3;
      }

      // Has valid status
      if (evidence.status && ['met', 'unmet', 'ambiguous'].includes(evidence.status)) {
        quality += 0.3;
      }

      // Has proof
      if (evidence.proof && evidence.proof.trim().length > 0) {
        quality += 0.4;
      }
    }

    return checks > 0 ? quality / checks : 0;
  }

  /**
   * Calculate feedback actionability score
   */
  private calculateFeedbackActionability(review: ReviewerOutput): number {
    const feedback = review.feedback.toLowerCase();

    // Check for actionable language
    const actionablePatterns = [
      /\b(should|must|need to|please|suggest|recommend)\b/,
      /\b(to|in order to|for)\b/,
      /\b(step|action|change|fix|add|remove|update)\b/
    ];

    let actionableCount = 0;
    for (const pattern of actionablePatterns) {
      if (pattern.test(feedback)) {
        actionableCount++;
      }
    }

    return actionableCount / actionablePatterns.length;
  }

  /**
   * Calculate filesystem verification score
   */
  private calculateFilesystemVerification(review: ReviewerOutput): number {
    const summary = review.filesystem_check_summary;

    if (!summary) return 0.5; // No summary

    // Check if filesystem was actually used
    const hasVerification = summary.files_verified.length > 0 ||
      summary.files_missing.length > 0 ||
      summary.files_too_short.length > 0;

    return hasVerification ? 1.0 : 0.5;
  }

  /**
   * Calculate suspicion handling score
   */
  private calculateSuspicionHandling(review: ReviewerOutput): number {
    // If suspicion score is present, check if it was handled appropriately
    if (review.suspicion_score === undefined) return 1.0; // Not applicable

    // High suspicion should lead to fail or refine
    if (review.suspicion_score > 0.7) {
      return (review.verdict === 'fail' || review.verdict === 'refine') ? 1.0 : 0.0;
    }

    // Low suspicion should not auto-fail
    if (review.suspicion_score < 0.3) {
      return review.verdict !== 'fail' ? 1.0 : 0.5;
    }

    return 1.0;
  }

  /**
   * Calculate soft fail usage score
   */
  private calculateSoftFailUsage(review: ReviewerOutput, testCase: TestCase): number {
    // Soft fail should be used for technical errors
    if (review.verdict === 'soft_fail') {
      const feedback = review.feedback.toLowerCase();
      const technicalErrorPatterns = [
        'timeout', 'error', 'technical', 'schema', 'failed'
      ];

      const hasTechnicalError = technicalErrorPatterns.some(p => feedback.includes(p));
      return hasTechnicalError ? 1.0 : 0.0;
    }

    // If not soft fail, that's fine unless test expects it
    if (testCase.expectedOutput.verdict === 'soft_fail') {
      return 0.0;
    }

    return 1.0;
  }

  /**
   * Calculate criteria coverage score
   */
  private calculateCriteriaCoverage(review: ReviewerOutput, testCase: TestCase): number {
    const acceptance = testCase.input.acceptance_criteria || testCase.description;
    const criteriaCount = this.countCriteria(acceptance);

    if (criteriaCount === 0) return 1.0; // No criteria to cover

    return Math.min(1.0, review.evidence.length / criteriaCount);
  }

  /**
   * Count acceptance criteria in text
   */
  private countCriteria(text: string): number {
    if (!text) return 0;

    const lineBulletCount = (text.match(/^[\s]*[-*•]\s+|^\s*\d+[.)]\s+/gm) ?? []).length;
    if (lineBulletCount > 1) return lineBulletCount;

    const inlineNumbered = (text.match(/(?:^|[\s;,])(\d+)[.)]\s+/g) ?? []).length;
    if (inlineNumbered > 1) return inlineNumbered;

    const semiCount = text.split(/;\s+/).filter((s) => s.trim().length > 0).length;
    if (semiCount > 1) return semiCount;

    return 1;
  }

  /**
   * Calculate completeness score
   */
  private calculateCompleteness(review: ReviewerOutput, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check if verdict is present
    checks++;
    if (review.verdict) {
      score += 1;
    }

    // Check if feedback is present
    checks++;
    if (review.feedback && review.feedback.length > 0) {
      score += 1;
    }

    // Check if evidence is present
    checks++;
    if (review.evidence && review.evidence.length > 0) {
      score += 1;
    }

    // Check if filesystem summary is present
    checks++;
    if (review.filesystem_check_summary) {
      score += 1;
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Calculate correctness score
   */
  private calculateCorrectness(review: ReviewerOutput, expected: any): number {
    let score = 0;
    let checks = 0;

    // Check verdict correctness
    if (expected.verdict) {
      checks++;
      if (review.verdict === expected.verdict) {
        score += 1;
      }
    }

    // Check if evidence status is valid
    checks++;
    const validStatuses = review.evidence.every(e =>
      ['met', 'unmet', 'ambiguous'].includes(e.status)
    );
    if (validStatuses) {
      score += 1;
    }

    // Check if llm_called is consistent with verdict
    checks++;
    if (review.verdict === 'soft_fail' && !review.llm_called) {
      // Soft fail without LLM call is acceptable (preHook short-circuit)
      score += 1;
    } else if (review.verdict !== 'soft_fail' && review.llm_called) {
      // Other verdicts should have LLM call
      score += 1;
    } else {
      score += 0.5;
    }

    return checks > 0 ? score / checks : 0;
  }

  /**
   * Estimate cost based on model, duration, and LLM usage
   */
  private estimateCost(model: string, duration: number, llmCalled: boolean): number {
    const rate = COST_PER_SECOND[getModelTier(model)];
    const effectiveDuration = llmCalled ? duration : 0; // No LLM cost if short-circuited
    return (effectiveDuration / 1000) * rate;
  }

  /**
   * Estimate token usage based on model, complexity, and LLM usage
   */
  private estimateTokens(model: string, complexity: string, llmCalled: boolean): number {
    if (!llmCalled) return 0; // No tokens if short-circuited

    const baseTokens = 1500; // Reviewer typically uses more tokens
    return baseTokens * COMPLEXITY_MULTIPLIER[complexity as keyof typeof COMPLEXITY_MULTIPLIER];
  }
}