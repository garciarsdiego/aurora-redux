/**
 * LLM-as-judge prompt for evaluating Planner agent quality.
 *
 * Focuses on plan quality dimensions:
 * - Completeness: coverage of all necessary steps
 * - Feasibility: technical feasibility given constraints
 * - Logical order: logical order of dependencies
 * - Risk assessment: identification and mitigation of risks
 * - Context coverage: use of workspace/rules/project knowledge
 * - Objective clarity: clarity and specificity of the objective
 */

/**
 * System prompt for the planner judge.
 */
export const PLANNER_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator of planning quality for AI agent workflows. Your role is to assess how well a plan (represented as a DAG) achieves its objective.

Your evaluation must be:
- Objective and evidence-based
- Specific about gaps or strengths
- Fair in considering constraints and complexity
- Clear about actionable improvements

You will evaluate the plan's completeness, feasibility, logical structure, risk handling, context integration, and objective clarity.`;

/**
 * User prompt template for planner evaluation.
 */
export interface PlannerJudgeInput {
  /** The objective the planner was given */
  objective: string;
  /** The DAG produced by the planner */
  dag: {
    tasks: Array<{
      id: string;
      name: string;
      kind: string;
      depends_on: string[];
      acceptance_criteria?: string | null;
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
 * Build the user prompt for planner evaluation.
 */
export function buildPlannerJudgePrompt(input: PlannerJudgeInput): string {
  const { objective, dag, context } = input;

  const prompt = `# Planner Evaluation Task

Evaluate the following plan (DAG) against quality dimensions for achieving the stated objective.

## Objective
${objective}

${context?.workspace ? `## Workspace Context\n${context.workspace}\n` : ''}
${context?.rules?.length ? `## Rules\n${context.rules.join('\n')}\n` : ''}
${context?.constraints?.length ? `## Constraints\n${context.constraints.join('\n')}\n` : ''}

## Plan (DAG)
${JSON.stringify(dag, null, 2)}

## Evaluation Dimensions

### 1. Plan Completeness
Assess whether the plan covers all necessary steps to achieve the objective.

**Criteria:**
- Step Coverage: Does the plan include all major phases (analysis, design, implementation, testing, deployment)?
- Missing Critical Steps: Are there obvious gaps that would prevent achieving the objective?
- End-to-End Flow: Can the plan be executed from start to finish without missing intermediate steps?
- Edge Cases: Does the plan address potential edge cases or error scenarios?
- Deliverable Completeness: Does each task have clear deliverables that contribute to the final objective?

**Scoring:**
- 1.0: Plan is comprehensive with all necessary steps, no gaps, covers edge cases
- 0.8-0.9: Plan covers most steps, minor gaps that could be addressed
- 0.5-0.7: Plan has significant gaps or missing major phases
- 0.0-0.4: Plan is incomplete, missing critical steps or cannot achieve objective

### 2. Plan Feasibility
Assess whether the plan is technically feasible given constraints.

**Criteria:**
- Technical Viability: Are the proposed approaches technically sound and achievable?
- Resource Constraints: Does the plan respect available resources (time, budget, compute)?
- Tool Availability: Are the required tools, models, or APIs available and accessible?
- Dependency Feasibility: Are external dependencies realistic and available?
- Complexity Management: Is the plan appropriately scoped or overly ambitious?
- Execution Reality: Can each task actually be executed as described?

**Scoring:**
- 1.0: Plan is highly feasible, all approaches are realistic and achievable
- 0.8-0.9: Plan is feasible with minor adjustments or assumptions
- 0.5-0.7: Plan has significant feasibility concerns or unrealistic assumptions
- 0.0-0.4: Plan is infeasible or requires major rework

### 3. Logical Order
Assess whether tasks are ordered logically with correct dependencies.

**Criteria:**
- Dependency Correctness: Do dependencies accurately reflect what each task needs?
- Sequential Flow: Do tasks follow a logical sequence (e.g., design before implementation)?
- Parallelization: Are independent tasks correctly identified and parallelized?
- No Circular Dependencies: Are there any circular dependencies that would cause deadlock?
- Prerequisite Satisfaction: Are all prerequisites available before dependent tasks run?
- Critical Path Efficiency: Is the critical path optimized or unnecessarily long?

**Scoring:**
- 1.0: Dependencies are perfectly logical, optimal parallelization, no cycles
- 0.8-0.9: Dependencies are correct with minor inefficiencies in ordering
- 0.5-0.7: Dependencies have significant issues (wrong order, missed parallelization)
- 0.0-0.4: Dependencies are incorrect, contain cycles, or prevent execution

### 4. Risk Assessment
Assess whether the plan identifies and mitigates potential risks.

**Criteria:**
- Risk Identification: Does the plan identify potential failure points or risks?
- Risk Coverage: Are major risk categories addressed (technical, operational, security)?
- Mitigation Strategies: Are there explicit mitigation or fallback strategies?
- Validation Steps: Does the plan include validation, testing, or quality gates?
- Error Handling: Are error scenarios and recovery paths considered?
- Rollback Plans: Can the plan be rolled back if something goes wrong?

**Scoring:**
- 1.0: Comprehensive risk assessment with clear mitigations for all major risks
- 0.8-0.9: Good risk coverage with mitigations for most risks
- 0.5-0.7: Limited risk identification or missing mitigation strategies
- 0.0-0.4: No risk assessment or completely ignores potential failures

### 5. Context Coverage
Assess whether the plan effectively uses available context.

**Criteria:**
- Workspace Awareness: Does the plan reference or use workspace-specific information?
- Rule Compliance: Does the plan respect project rules, conventions, or guidelines?
- Project Knowledge: Does the plan leverage existing project structure or patterns?
- Context Integration: Is available context (files, docs, history) effectively utilized?
- Customization: Is the plan tailored to the specific project context vs. generic?
- Constraint Awareness: Does the plan respect project-specific constraints or limitations?

**Scoring:**
- 1.0: Plan deeply integrates all available context, highly customized to project
- 0.8-0.9: Plan uses most relevant context, well-tailored to project
- 0.5-0.7: Plan uses limited context, somewhat generic
- 0.0-0.4: Plan ignores available context or is completely generic

### 6. Objective Clarity
Assess whether the objective is clear, specific, and actionable.

**Criteria:**
- Specificity: Is the objective specific rather than vague or ambiguous?
- Measurability: Can success be measured or verified?
- Actionability: Is it clear what actions need to be taken?
- Scope Clarity: Are the boundaries and scope of the objective clear?
- Success Criteria: Are there clear criteria for when the objective is achieved?
- Ambiguity Check: Are there multiple interpretations or unclear terms?

**Scoring:**
- 1.0: Objective is crystal clear, specific, measurable, and unambiguous
- 0.8-0.9: Objective is clear with minor ambiguity
- 0.5-0.7: Objective is somewhat vague or lacks clear success criteria
- 0.0-0.4: Objective is ambiguous, unclear, or cannot be acted upon

## Overall Scoring Guidelines

Calculate the overall score as a weighted average:
- Completeness: 25%
- Feasibility: 25%
- Logical Order: 20%
- Risk Assessment: 15%
- Context Coverage: 10%
- Objective Clarity: 5%

**Overall Score Interpretation:**
- **1.0**: Excellent plan across all dimensions
- **0.8-0.9**: Strong plan with minor weaknesses
- **0.6-0.7**: Adequate plan with notable gaps
- **0.4-0.5**: Weak plan requiring significant revision
- **0.0-0.3**: Unacceptable plan

## Required Output Format

Respond with JSON in this exact format:
\`\`\`json
{
  "score": <number between 0 and 1>,
  "reasoning": "<detailed explanation of each dimension's evaluation>",
  "passed": <boolean: true if score >= 0.7, false otherwise>,
  "dimension_scores": {
    "completeness": <number between 0 and 1>,
    "feasibility": <number between 0 and 1>,
    "logical_order": <number between 0 and 1>,
    "risk_assessment": <number between 0 and 1>,
    "context_coverage": <number between 0 and 1>,
    "objective_clarity": <number between 0 and 1>
  },
  "strengths": ["<specific strengths observed>"],
  "weaknesses": ["<specific weaknesses or gaps>"],
  "recommendations": ["<actionable recommendations for improvement>"]
}
\`\`\`

Be specific in your reasoning, referencing specific task IDs and concrete evidence.`;

  return prompt;
}

/**
 * Factory function to create a configured planner judge prompt.
 */
export interface PlannerJudgeConfig {
  /** Optional custom system prompt */
  systemPrompt?: string;
  /** Whether to include context in the prompt */
  includeContext?: boolean;
  /** Custom weights for dimensions (sum should be 1.0) */
  weights?: {
    completeness?: number;
    feasibility?: number;
    logical_order?: number;
    risk_assessment?: number;
    context_coverage?: number;
    objective_clarity?: number;
  };
}

export function createPlannerJudgePrompt(
  input: PlannerJudgeInput,
  config?: PlannerJudgeConfig
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = config?.systemPrompt ?? PLANNER_JUDGE_SYSTEM_PROMPT;
  const userPrompt = buildPlannerJudgePrompt(input);

  return { systemPrompt, userPrompt };
}