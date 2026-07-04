/**
 * LLM-as-judge prompt for evaluating Reviewer agent quality.
 *
 * Focuses on review quality dimensions:
 * - Evidence-based: concrete evidence for verdict
 * - Actionable: specific, clear guidance for improvement
 * - Fair: appropriate verdict given evidence
 * - Completeness: evaluates all acceptance criteria
 * - Consistency: consistent with similar evaluations
 * - Strictness calibration: appropriate rejection rate
 */

/**
 * System prompt for the reviewer judge.
 */
export const REVIEWER_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator of review quality for AI agent workflows. Your role is to assess how well a reviewer evaluates task outputs against acceptance criteria.

Your evaluation must be:
- Objective and evidence-based
- Fair in assessing the reviewer's verdict
- Specific about feedback quality
- Clear about whether the review is actionable

You will evaluate the reviewer's output for evidence quality, actionability, fairness, completeness, and overall effectiveness.`;

/**
 * User prompt template for reviewer evaluation.
 */
export interface ReviewerJudgeInput {
  /** The task being reviewed */
  task: {
    name: string;
    kind: string;
    acceptance_criteria?: string | null;
  };
  /** The actual work output being reviewed */
  workOutput: string;
  /** The reviewer's evaluation */
  reviewerOutput: {
    passed: boolean;
    score?: number;
    confidence?: number;
    feedback?: string | null;
    caveats?: string[] | null;
  };
  /** Optional ground truth for calibration */
  groundTruth?: {
    shouldPass: boolean;
    confidence?: number;
  };
}

/**
 * Build the user prompt for reviewer evaluation.
 */
export function buildReviewerJudgePrompt(input: ReviewerJudgeInput): string {
  const { task, workOutput, reviewerOutput, groundTruth } = input;

  const prompt = `# Reviewer Evaluation Task

Evaluate the quality of the reviewer's assessment of the task output against acceptance criteria.

## Task Information
**Task Name:** ${task.name}
**Task Kind:** ${task.kind}
**Acceptance Criteria:** ${task.acceptance_criteria || 'None specified'}

## Work Output (being reviewed)
\`\`\`
${workOutput}
\`\`\`

## Reviewer's Evaluation
**Verdict:** ${reviewerOutput.passed ? 'PASS' : 'FAIL'}
${reviewerOutput.score !== undefined ? `**Score:** ${reviewerOutput.score}` : ''}
${reviewerOutput.confidence !== undefined ? `**Confidence:** ${reviewerOutput.confidence}` : ''}
${reviewerOutput.feedback ? `**Feedback:**\n${reviewerOutput.feedback}` : ''}
${reviewerOutput.caveats?.length ? `**Caveats:**\n${reviewerOutput.caveats.join('\n')}` : ''}

${groundTruth ? `## Ground Truth (for calibration)
**Should Pass:** ${groundTruth.shouldPass}
${groundTruth.confidence !== undefined ? `**Confidence:** ${groundTruth.confidence}` : ''}` : ''}

## Evaluation Dimensions

### 1. Evidence-Based
Assess whether the reviewer provides concrete evidence for their verdict.

**Criteria:**
- Evidence Indicators: Does feedback use words like "because", "since", "due to", "as shown"?
- Specific References: Does feedback reference specific parts of the work output?
- Concrete Examples: Does feedback include quotes or specific examples?
- Factual Basis: Is the verdict based on observable facts rather than opinions?

**Scoring:**
- 1.0: Strong evidence with specific references and concrete examples
- 0.7-0.9: Good evidence with some specificity
- 0.4-0.6: Weak evidence, vague references
- 0.0-0.3: No evidence provided, verdict appears arbitrary

### 2. Actionable
Assess whether the feedback provides clear, specific guidance for improvement.

**Criteria:**
- Actionability: Does feedback use action verbs (should, must, need to, add, remove, change)?
- Specificity: Does feedback reference specific acceptance criteria or output issues?
- Clarity: Is feedback unambiguous and easy to understand?
- Constructiveness: Does feedback help improve the output rather than just criticizing?
- Steps Provided: Are there clear steps for addressing issues?

**Scoring:**
- 1.0: Highly actionable with specific, clear improvement steps
- 0.7-0.9: Actionable with minor ambiguity
- 0.4-0.6: Somewhat actionable but lacks specificity
- 0.0-0.3: Not actionable, vague or unhelpful

### 3. Fairness
Assess whether the verdict is appropriate given the evidence provided.

**Criteria:**
- Verdict Consistency: If passed, is feedback positive or has only minor caveats? If failed, are there clear reasons?
- Evidence Alignment: Does the verdict align with the strength of evidence?
- Proportionality: Is the verdict proportionate to the severity of issues?
- No Bias: Is there evidence of bias (over-strict, over-lenient)?

**Scoring:**
- 1.0: Verdict perfectly aligned with evidence, no bias detected
- 0.7-0.9: Verdict generally fair with minor inconsistencies
- 0.4-0.6: Verdict questionable given evidence
- 0.0-0.3: Verdict unfair or biased

### 4. Completeness
Assess whether the reviewer evaluates all acceptance criteria.

**Criteria:**
- Criteria Coverage: Does feedback address all parts of the acceptance criteria?
- Missing Evaluation: Are there criteria parts not mentioned in feedback?
- Thoroughness: Does the reviewer check all aspects mentioned in criteria?

**Scoring:**
- 1.0: All acceptance criteria thoroughly evaluated
- 0.7-0.9: Most criteria evaluated, minor omissions
- 0.4-0.6: Significant criteria not evaluated
- 0.0-0.3: Most criteria ignored

### 5. Strictness Calibration (if ground truth available)
Assess whether the reviewer's verdict aligns with ground truth.

**Criteria:**
- Alignment: Does the reviewer's verdict match ground truth?
- False Positive: Did reviewer reject when ground truth says should pass?
- False Negative: Did reviewer accept when ground truth says should fail?
- Confidence Calibration: Is reviewer confidence appropriate?

**Scoring:**
- 1.0: Perfect alignment with ground truth
- 0.7-0.9: Minor misalignment or confidence issues
- 0.4-0.6: Significant misalignment with ground truth
- 0.0-0.3: Opposite of ground truth

## Overall Scoring Guidelines

Calculate the overall score as a weighted average:
- Evidence-Based: 30%
- Actionable: 25%
- Fairness: 25%
- Completeness: 20%
- Strictness Calibration: 0% (if no ground truth) or 10% (if ground truth available)

**Overall Score Interpretation:**
- **1.0**: Excellent review quality across all dimensions
- **0.8-0.9**: Strong review with minor weaknesses
- **0.6-0.7**: Adequate review with notable gaps
- **0.4-0.5**: Weak review requiring significant improvement
- **0.0-0.3**: Unacceptable review quality

## Required Output Format

Respond with JSON in this exact format:
\`\`\`json
{
  "score": <number between 0 and 1>,
  "reasoning": "<detailed explanation of each dimension's evaluation>",
  "passed": <boolean: true if score >= 0.7, false otherwise>,
  "dimension_scores": {
    "evidence_based": <number between 0 and 1>,
    "actionable": <number between 0 and 1>,
    "fairness": <number between 0 and 1>,
    "completeness": <number between 0 and 1>,
    "strictness_calibration": <number between 0 and 1 or null if no ground truth>
  },
  "strengths": ["<specific strengths observed>"],
  "weaknesses": ["<specific weaknesses or gaps>"],
  "recommendations": ["<actionable recommendations for improving the review>"]
}
\`\`\`

Be specific in your reasoning, quoting relevant parts of the feedback and work output.`;

  return prompt;
}

/**
 * Factory function to create a configured reviewer judge prompt.
 */
export interface ReviewerJudgeConfig {
  /** Optional custom system prompt */
  systemPrompt?: string;
  /** Whether to include ground truth in the prompt */
  includeGroundTruth?: boolean;
  /** Custom weights for dimensions (sum should be 1.0) */
  weights?: {
    evidence_based?: number;
    actionable?: number;
    fairness?: number;
    completeness?: number;
    strictness_calibration?: number;
  };
}

export function createReviewerJudgePrompt(
  input: ReviewerJudgeInput,
  config?: ReviewerJudgeConfig
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = config?.systemPrompt ?? REVIEWER_JUDGE_SYSTEM_PROMPT;
  const userPrompt = buildReviewerJudgePrompt(input);

  return { systemPrompt, userPrompt };
}