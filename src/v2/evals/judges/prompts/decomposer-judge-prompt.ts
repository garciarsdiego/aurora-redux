/**
 * LLM-as-judge prompt for evaluating Decomposer agent quality.
 *
 * Focuses on H1-H19 heuristic compliance:
 * - H1: Granularity (atomic tasks)
 * - H2: Fan-out (parallel execution of independent tasks)
 * - H3: Critical path ≤ 10
 * - H4: Output scope (~10K char limit)
 * - H5: Kind by nature (appropriate task kind for work type)
 * - H6: Downstream selectors (focused data passing)
 * - H7: Falsifiable criteria (mechanically verifiable)
 * - H8: Explicit reviewer (substantive tasks have criteria)
 * - H9: Failure mode (anticipate failures)
 * - H10: Model/CLI compatibility
 * - H11: Plan gate (t0 structure)
 * - H12: Timeout hints
 * - H13: Falsifiable acceptance criteria (all non-t0)
 * - H14: Parallel-task contract consistency
 * - H15: Multi-model diversity
 * - H16: Native subagent delegation
 * - H17: Tool call vs CLI spawn for file writes
 * - H18: Semantic dependencies
 * - H19: (reserved for future)
 */

/**
 * System prompt for the decomposer judge.
 */
export const DECOMPOSER_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator of task decomposition quality for AI agent workflows. Your role is to assess how well a decomposed Directed Acyclic Graph (DAG) adheres to the 19 decomposition heuristics (H1-H19).

Your evaluation must be:
- Objective and evidence-based
- Specific about violations or strengths
- Fair in considering trade-offs
- Clear about which heuristics are violated

You will evaluate the DAG structure, task definitions, dependencies, and acceptance criteria against the heuristics.`;

/**
 * User prompt template for decomposer evaluation.
 */
export interface DecomposerJudgeInput {
  /** The objective the decomposer was given */
  objective: string;
  /** The DAG produced by the decomposer */
  dag: {
    tasks: Array<{
      id: string;
      name: string;
      kind: string;
      depends_on: string[];
      executor_hint?: string | null;
      acceptance_criteria?: string | null;
      model?: string | null;
      tool_name?: string | null;
      hitl?: boolean;
      input_selectors?: Record<string, unknown>;
      output_summary?: string;
      timeout_seconds?: number;
      args?: Record<string, unknown>;
    }>;
  };
  /** Optional context (workspace, rules, constraints) */
  context?: {
    workspace?: string;
    rules?: string[];
    constraints?: string[];
  };
}

/**
 * Build the user prompt for decomposer evaluation.
 */
export function buildDecomposerJudgePrompt(input: DecomposerJudgeInput): string {
  const { objective, dag, context } = input;

  const prompt = `# Decomposer Evaluation Task

Evaluate the following task decomposition against the H1-H19 heuristics.

## Objective
${objective}

${context?.workspace ? `## Workspace Context\n${context.workspace}\n` : ''}
${context?.rules?.length ? `## Rules\n${context.rules.join('\n')}\n` : ''}
${context?.constraints?.length ? `## Constraints\n${context.constraints.join('\n')}\n` : ''}

## DAG Structure
${JSON.stringify(dag, null, 2)}

## Heuristics to Evaluate

### MANDATORY Heuristics (must pass)
- **H2 Fan-Out**: Independent tasks MUST run in parallel. If two tasks do not share a data dependency beyond t0, they MUST both depend only on t0.
- **H3 Critical Path ≤ 10**: Longest sequential chain must not exceed 10 tasks.
- **H7 Falsifiable Criteria**: Acceptance criteria must be mechanically verifiable (no vague phrases like "should work correctly").
- **H10 Model/CLI Compatibility**: Model provider prefix must match CLI family (e.g., claude-code with cc/anthropic, codex with cx/openai).
- **H11 Plan Gate**: First task must be t0 with kind=llm_call, hitl=true, empty depends_on, model=null, tool_name=null.
- **H13 Falsifiable Acceptance Criteria**: Every non-t0 task must have falsifiable acceptance criteria.

### RECOMMENDED Heuristics (should pass with high score)
- **H1 Granularity**: Each task should be atomic (one decision or deliverable). Acceptance criteria should be one sentence.
- **H4 Output Scope**: Task outputs should be bounded (~10K characters max).
- **H5 Kind by Nature**: Task kind should match work type (llm_call for text, cli_spawn for code, tool_call for deterministic actions, pal_call for consensus).
- **H6 Downstream Selectors**: Tasks should receive only necessary data from upstream (use input_selectors, avoid raw_full).
- **H8 Explicit Reviewer**: Every substantive task should have acceptance_criteria.
- **H9 Failure Mode**: Tasks should anticipate failures and cascades (handle edge cases, empty results, errors).
- **H12 Timeout Hints**: Long-running tasks (>3 min) should have timeout_seconds set.
- **H14 Parallel-Task Contract Consistency**: Tasks in same parallel group must agree on shared contracts.
- **H15 Multi-Model Diversity**: Intentional model diversification when beneficial (pal_call for consensus, different models for review vs implementation).
- **H16 Native Subagent Delegation**: Subagent tasks should be cli_spawn with generous timeout (≥1200s) and MUST-language in criteria.
- **H17 Tool Call vs CLI Spawn**: tool_call should only be used for small, structured config (<500 chars). Use cli_spawn for larger file writes.
- **H18 Semantic Dependencies**: Tasks must consider data, contract, and file dependencies (imports, includes, requires).

## Evaluation Criteria

For each heuristic, assess:
1. **Compliance**: Does the DAG adhere to the heuristic?
2. **Severity**: If violated, how severe is the violation (critical/major/minor)?
3. **Impact**: What is the impact on execution (blocking, inefficient, risky)?
4. **Evidence**: Provide specific task IDs and values that support your assessment.

## Scoring Guidelines

- **1.0**: All mandatory heuristics pass, all recommended heuristics pass or have minor acceptable deviations
- **0.8-0.9**: All mandatory heuristics pass, some recommended heuristics have minor violations
- **0.5-0.7**: One or more mandatory heuristics have minor violations, or multiple recommended heuristics have major violations
- **0.0-0.4**: One or more mandatory heuristics have critical violations, preventing execution

## Required Output Format

Respond with JSON in this exact format:
\`\`\`json
{
  "score": <number between 0 and 1>,
  "reasoning": "<detailed explanation of heuristic compliance, violations, and evidence>",
  "passed": <boolean: true if score >= 0.8, false otherwise>,
  "mandatory_violations": [
    {
      "heuristic": "<H number and name>",
      "severity": "<critical|major|minor>",
      "task_id": "<affected task ID or 'multiple'>",
      "description": "<specific violation description>"
    }
  ],
  "recommended_violations": [
    {
      "heuristic": "<H number and name>",
      "severity": "<major|minor>",
      "task_id": "<affected task ID or 'multiple'>",
      "description": "<specific violation description>"
    }
  ],
  "strengths": ["<specific strengths observed>"]
}
\`\`\`

Focus on being specific with task IDs and concrete evidence in your reasoning.`;

  return prompt;
}

/**
 * Factory function to create a configured decomposer judge prompt.
 */
export interface DecomposerJudgeConfig {
  /** Optional custom system prompt */
  systemPrompt?: string;
  /** Whether to include context in the prompt */
  includeContext?: boolean;
  /** Whether to focus only on mandatory heuristics */
  mandatoryOnly?: boolean;
}

export function createDecomposerJudgePrompt(
  input: DecomposerJudgeInput,
  config?: DecomposerJudgeConfig
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = config?.systemPrompt ?? DECOMPOSER_JUDGE_SYSTEM_PROMPT;
  const userPrompt = buildDecomposerJudgePrompt(input);

  return { systemPrompt, userPrompt };
}