import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Task, ReviewResult } from '../types/index.js';
import { callOmniroute } from '../utils/omniroute-call.js';
import { getReviewerModel, getUsePersonas } from '../utils/config.js';
import {
  ReviewOutcomeSchema,
  reviewOutcomeToResult,
  reviewViaPersona,
  type ReviewOutcome,
  type ReviewerRuntimeContext,
} from '../v2/reviewer/outcome.js';
import { AgentOutputError, AgentRejectedError } from '../v2/agents/types.js';
import { isCliSafeMode } from '../executors/cli.js';
import { loadProjectRules, formatRulesForPrompt } from '../v2/rules/loader.js';
import { evaluateDeterministic } from './deterministic-checks.js';

const SYSTEM_PROMPT = `You are Omniforge's reviewer. Given a TASK and its OUTPUT, judge how well the output meets the acceptance criteria.

Return STRICT JSON only. No prose, no commentary, no markdown fences. The output MUST match exactly this shape:

{
  "outcome_type": "hard_success" | "soft_success" | "soft_failure" | "hard_failure" | "scope_conflict",
  "confidence": 0.0-1.0,
  "feedback": "...",
  "caveats": ["..."],
  "next_action": "refine" | "fallback_model" | "abort" | "escalate_human",
  "refine_hint": "..."
}

Rules:
- hard_success: output fully meets criteria, clear and complete
- soft_success: acceptable but document caveats honestly
- soft_failure: output is wrong but a clearer refinement is likely to fix it
- hard_failure: output is fundamentally wrong; no refinement will save it
- scope_conflict: output went beyond scope; needs scope decision

Be strict but fair. Focus on substance, not style. Feedback must be actionable.`;

// Matches file paths in task output: ~/..., /abs/path, C:/windows/path
const FILE_PATH_RE = /(?:^|\s)((?:~\/|\/|[A-Za-z]:[/\\])[^\s]+\.\w{2,10})/m;

function extractFilePath(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed['file_path'] === 'string') return parsed['file_path'] as string;
  } catch { /* not JSON */ }
  return output.match(FILE_PATH_RE)?.[1] ?? null;
}

export function getReviewerClaudeArgs(): string[] {
  // Mirror executors/cli.ts safeMode toggle. Without this, a CLI_SAFE_MODE=true
  // setup still bypasses permissions in the reviewer flow.
  const safeMode = isCliSafeMode();
  return safeMode ? ['--print'] : ['--print', '--dangerously-skip-permissions'];
}

export function getReviewerSpawnOptions(): SpawnOptionsWithoutStdio {
  return {
    shell: false,
    stdio: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  };
}

function spawnClaude(prompt: string): Promise<string> {
  const claudeArgs = getReviewerClaudeArgs();
  return new Promise((resolve, reject) => {
    const child = spawn('claude', claudeArgs, getReviewerSpawnOptions());
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));
    // Swallow EPIPE when the spawn fails before stdin is consumed; the
    // 'error'/'close' handlers below report the real cause.
    child.stdin.on('error', () => {});
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        reject(new Error(
          `Reviewer CLI exited ${String(code)}${stderr ? `. Stderr: ${stderr.slice(0, 300)}` : ''}`,
        ));
      }
    });
    child.on('error', (err: Error) => reject(new Error(`Reviewer CLI spawn: ${err.message}`)));
  });
}

async function reviewViaCli(task: Task, filePath: string): Promise<ReviewResult> {
  const criteria = task.acceptance_criteria ?? task.name;
  const prompt = [
    `Read the file at "${filePath}" and evaluate whether it fully meets these acceptance criteria:`,
    '',
    criteria,
    '',
    'Return STRICT JSON only — no markdown, no prose:',
    '{',
    '  "outcome_type": "hard_success" | "soft_success" | "soft_failure" | "hard_failure",',
    '  "confidence": 0.0-1.0,',
    '  "feedback": "...",',
    '  "caveats": ["..."],',
    '  "next_action": "refine" | "abort",',
    '  "refine_hint": "..."',
    '}',
  ].join('\n');

  const raw = await spawnClaude(prompt);
  return reviewOutcomeToResult(parseReviewOutput(raw));
}

function buildUserPrompt(task: Task, output: string): string {
  const parts: string[] = [`TASK: ${task.name}`];
  if (task.acceptance_criteria) {
    parts.push(`ACCEPTANCE CRITERIA: ${task.acceptance_criteria}`);
  }
  parts.push(`OUTPUT:\n${output}`);
  return parts.join('\n\n');
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return match?.[1]?.trim() ?? trimmed;
}

/**
 * Defensive JSON extraction for LLM outputs that may prefix narrative reasoning
 * before the actual JSON object (real failure mode observed in 2026-04-23
 * Tetris workflow: reviewer CLI returned "Let me analyze the task output
 * carefully...\n\n{\"outcome_type\":...}").
 *
 * Strategy: outermost `{` to outermost `}`. Handles narrative prefix/suffix.
 * Returns null if no plausible JSON object boundaries found.
 *
 * Limitations: assumes a single top-level JSON object. If the text contains
 * multiple unrelated `{...}` blocks, takes the broadest range — may include
 * garbage between objects, which JSON.parse will reject (caller falls back
 * to the original error). Acceptable: alternative is full bracket-balancing
 * with string-aware tokenizer, which is more code than the failure mode warrants.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// Exported for unit-testing parse logic without an LLM roundtrip.
export function parseReviewOutput(raw: string): ReviewOutcome {
  const jsonText = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (firstErr) {
    // LLM may have prefixed narrative reasoning before the JSON object.
    // Try extracting just the {...} block before giving up.
    const extracted = extractJsonObject(jsonText);
    if (extracted === null) {
      throw new Error(
        `Reviewer: failed to parse LLM output as JSON. ` +
          `Error: ${(firstErr as Error).message}. ` +
          `Preview: ${jsonText.slice(0, 300)}`,
      );
    }
    try {
      parsed = JSON.parse(extracted);
    } catch (secondErr) {
      throw new Error(
        `Reviewer: failed to parse LLM output as JSON (tried extracted {...} block too). ` +
          `Error: ${(secondErr as Error).message}. ` +
          `Preview: ${jsonText.slice(0, 300)}`,
      );
    }
  }
  const validated = ReviewOutcomeSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Reviewer: output did not match schema. ` +
        `Issues: ${JSON.stringify(validated.error.issues).slice(0, 300)}. ` +
        `Preview: ${jsonText.slice(0, 300)}`,
    );
  }
  return validated.data;
}

/**
 * OPP-R1 — deterministic-first reviewer gate.
 *
 * Runs structural assertions extracted from `acceptance_criteria` BEFORE
 * spending tokens on the LLM judge. Returns:
 *   - ReviewResult on hard pass / hard fail (skip LLM entirely)
 *   - null when assertions are inconclusive (caller falls back to LLM)
 *
 * Exported so the LLM judge mirror in `src/v2/evals/judges/llm-judge.ts`
 * can share the same logic.
 */
export function deterministicReview(task: Task, output: string): ReviewResult | null {
  const result = evaluateDeterministic(task.acceptance_criteria, output);
  if (result.verdict === 'inconclusive') return null;
  if (result.verdict === 'all_pass') {
    return {
      score: 1.0,
      feedback:
        `Deterministic checks passed (${result.results.length}/${result.results.length}).\n` +
        result.summary,
      passed: true,
    };
  }
  // any_fail
  return {
    score: 0,
    feedback: `Deterministic check failed.\n${result.summary}`,
    passed: false,
  };
}

export async function reviewTask(
  task: Task,
  output: string,
  ctx: ReviewerRuntimeContext = {},
): Promise<ReviewResult> {
  // OPP-R1 — try deterministic checks first; only escalate to LLM if inconclusive.
  const det = deterministicReview(task, output);
  if (det !== null) return det;

  if (getUsePersonas()) {
    try {
      return await reviewViaPersona(task, output, ctx);
    } catch (err) {
      if (!(err instanceof AgentRejectedError) && !(err instanceof AgentOutputError)) {
        throw err;
      }
      console.warn('[reviewer-persona] Falling back to legacy reviewer path', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // For cli_spawn tasks that wrote a file: validate by reading the actual file via CLI.
  // This is more accurate than evaluating a text summary and has no size limits.
  if (task.kind === 'cli_spawn') {
    const filePath = extractFilePath(output);
    if (filePath) return reviewViaCli(task, filePath);
  }

  const rules = await loadProjectRules(process.cwd()).catch(() => null);
  const raw = await callOmniroute({
    systemPrompt: SYSTEM_PROMPT + formatRulesForPrompt(rules, 'reviewer'),
    userPrompt: buildUserPrompt(task, output),
    model: getReviewerModel(),
  });

  return reviewOutcomeToResult(parseReviewOutput(raw));
}
