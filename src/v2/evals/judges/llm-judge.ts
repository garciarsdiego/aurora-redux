/**
 * LLM-based judge for evaluation.
 *
 * Uses an LLM via Omniroute to evaluate outputs against expected results.
 * Supports multiple iterations with aggregation, caching, and soft-fail error handling.
 */

import { z } from 'zod';
import crypto from 'node:crypto';
import type { Judge, JudgeInput, JudgeOutput } from '../types.js';
import type { LlmJudgeConfig } from '../types.js';
import { LlmJudgeConfigSchema } from '../types.js';
import { callOmnirouteWithUsage } from '../../../utils/omniroute-call.js';
import { evaluateDeterministic } from '../../../reviewer/deterministic-checks.js';
import { extractJsonFromResponse } from './prompts/index.js';

/**
 * Schema for LLM judge response.
 */
const LlmJudgeResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});

type LlmJudgeResponse = z.infer<typeof LlmJudgeResponseSchema>;

/**
 * In-memory cache for judge results (preparation for eval_judge_cache table).
 * In production, this should be replaced with a database-backed cache.
 */
interface CacheEntry {
  score: number;
  reason: string;
  raw: string;
  cost_usd: number;
}

class JudgeCache {
  private cache = new Map<string, CacheEntry>();

  set(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
  }

  get(key: string): CacheEntry | undefined {
    return this.cache.get(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Build a zero-score soft-fail JudgeOutput. Shared by every failure path in
 * `LLMJudge.evaluate` so score/latency_ms/cache_hit can't drift between them.
 */
function softFail(reason: string, raw: string, start: number, cost_usd = 0): JudgeOutput {
  return {
    score: 0,
    reason,
    raw,
    cost_usd,
    latency_ms: Date.now() - start,
    cache_hit: false,
  };
}

/**
 * LLM-based judge implementation.
 *
 * Evaluates outputs by prompting an LLM to score them based on a rubric.
 * Supports:
 * - Multiple iterations with aggregation (mean/median/min)
 * - Caching of results
 * - Soft-fail on errors (returns score 0 with reason instead of throwing)
 */
export class LLMJudge implements Judge {
  readonly name = 'llm-judge';
  readonly version = 'v1';

  private readonly config: LlmJudgeConfig;
  private readonly cache: JudgeCache;

  constructor(config: unknown) {
    this.config = LlmJudgeConfigSchema.parse(config);
    this.cache = new JudgeCache();
  }

  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    const start = Date.now();

    // OPP-R1 mirror: short-circuit on deterministic structural assertions.
    // Skips the LLM call entirely when the rubric+expected contain
    // parseable shape checks (regex, JSON keys, line/word count, etc.).
    const det = tryDeterministicShapeCheck(input);
    if (det !== null) {
      return {
        score: det.score,
        reason: det.reason,
        raw: JSON.stringify({ deterministic: true, verdict: det.verdict, results: det.results }),
        cost_usd: 0,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    }

    try {
      // Computed once (not per get/set) and reused below when caching is enabled.
      const cacheKey = this.config.cache ? this.computeCacheKey(input) : null;

      // Check cache if enabled
      if (cacheKey) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          return {
            score: cached.score,
            reason: cached.reason,
            raw: cached.raw,
            cost_usd: cached.cost_usd,
            latency_ms: Date.now() - start,
            cache_hit: true,
          };
        }
      }

      // Run multiple iterations if configured
      const iterations = this.config.iterations;
      const results: LlmJudgeResponse[] = [];
      let totalCost = 0;

      for (let i = 0; i < iterations; i++) {
        try {
          const { response, cost } = await this.callLLM(input);
          results.push(response);
          totalCost += cost;
        } catch (error) {
          // Soft-fail: log error but don't throw
          if (iterations === 1) {
            return softFail(
              `LLM judge failed: ${error instanceof Error ? error.message : String(error)}`,
              JSON.stringify({ error: String(error) }),
              start,
            );
          }
          // If multiple iterations, skip this one and continue
          continue;
        }
      }

      if (results.length === 0) {
        return softFail(
          'All LLM judge iterations failed',
          JSON.stringify({ error: 'All iterations failed' }),
          start,
          totalCost,
        );
      }

      // Aggregate results
      const aggregated = this.aggregateResults(results);
      const raw = JSON.stringify({ iterations: results, aggregated });

      // Cache the result if enabled
      if (cacheKey) {
        this.cache.set(cacheKey, {
          score: aggregated.score,
          reason: aggregated.reason,
          raw,
          cost_usd: totalCost,
        });
      }

      return {
        score: aggregated.score,
        reason: aggregated.reason,
        raw,
        cost_usd: totalCost,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    } catch (error) {
      // Soft-fail: return score 0 with error reason
      return softFail(
        `LLM judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        JSON.stringify({ error: String(error) }),
        start,
      );
    }
  }

  /**
   * Call the LLM via Omniroute to evaluate the input.
   */
  private async callLLM(input: JudgeInput): Promise<{ response: LlmJudgeResponse; cost: number }> {
    const prompt = this.buildPrompt(input);

    const result = await callOmnirouteWithUsage({
      systemPrompt: this.getSystemPrompt(),
      userPrompt: prompt,
      model: this.config.model,
      temperature: this.config.temperature,
    });

    const cost = result.usage?.total_cost_usd ?? 0;

    // Parse the LLM response (shared extractor — handles markdown/plain code
    // blocks and bare-object fallback more robustly than a single regex pair).
    let responseJson: unknown;
    try {
      responseJson = extractJsonFromResponse(result.content);
    } catch (error) {
      throw new Error(`Failed to parse LLM response as JSON: ${error instanceof Error ? error.message : String(error)}. Response: ${result.content.slice(0, 500)}`);
    }

    // Validate the response schema
    const response = LlmJudgeResponseSchema.parse(responseJson);

    return { response, cost };
  }

  /**
   * Build the evaluation prompt for the LLM.
   */
  private buildPrompt(input: JudgeInput): string {
    const { output, expected, rubric, steps } = input;

    let prompt = `You are an expert evaluator. Please evaluate the following output based on the expected result and rubric.\n\n`;

    prompt += `**Expected Result:**\n${JSON.stringify(expected, null, 2)}\n\n`;
    prompt += `**Actual Output:**\n${JSON.stringify(output, null, 2)}\n\n`;
    prompt += `**Evaluation Rubric:**\n${rubric}\n\n`;

    if (steps && steps.length > 0) {
      prompt += `**Evaluation Steps:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n`;
    }

    prompt += `Please provide:\n`;
    prompt += `1. A score between 0 (completely incorrect) and 1 (perfectly correct)\n`;
    prompt += `2. A brief reason for your score\n\n`;
    prompt += `Respond in JSON format:\n`;
    prompt += `{\n  "score": <number between 0 and 1>,\n  "reason": "<brief explanation>"\n}`;

    return prompt;
  }

  /**
   * Get the system prompt for the LLM judge.
   */
  private getSystemPrompt(): string {
    return `You are an impartial and thorough evaluator. Your task is to assess how well an output matches an expected result based on a provided rubric.

Guidelines:
- Be objective and fair
- Consider partial correctness - assign scores between 0 and 1 for partially correct answers
- Provide clear, concise reasons for your scores
- Focus on the key aspects mentioned in the rubric
- If the output exceeds expectations in some areas but fails in others, weigh the overall quality`;
  }

  /**
   * Aggregate multiple iteration results based on the configured strategy.
   */
  private aggregateResults(results: LlmJudgeResponse[]): LlmJudgeResponse {
    if (results.length === 1) {
      return results[0];
    }

    const scores = results.map((r) => r.score);
    let aggregatedScore: number;

    switch (this.config.aggregate) {
      case 'mean':
        aggregatedScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        break;
      case 'median':
        const sorted = [...scores].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        aggregatedScore = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        break;
      case 'min':
        aggregatedScore = Math.min(...scores);
        break;
      default:
        aggregatedScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    // Combine reasons from all iterations
    const combinedReason = results.map((r, i) => `[Iteration ${i + 1}] ${r.reason}`).join('\n\n');

    return {
      score: aggregatedScore,
      reason: `Aggregated from ${results.length} iterations (${this.config.aggregate}).\n\n${combinedReason}`,
    };
  }

  /**
   * Compute a cache key for the input.
   * Uses a hash of the relevant input fields.
   */
  private computeCacheKey(input: JudgeInput): string {
    const key = {
      model: this.config.model,
      temperature: this.config.temperature,
      output: input.output,
      expected: input.expected,
      rubric: input.rubric,
      steps: input.steps,
    };

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(key))
      .digest('hex');

    return `${this.name}:${this.version}:${hash}`;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * OPP-R1 shape-check mirror for the LLM judge. Returns null when no structural
 * assertions can be parsed (caller falls back to the LLM call); otherwise
 * returns a fully-resolved verdict that bypasses the LLM entirely.
 *
 * Pulls criteria text from `input.rubric` and (when it is a string)
 * `input.expected`. The output payload is stringified for substring/JSON checks.
 */
function tryDeterministicShapeCheck(input: JudgeInput): {
  score: number;
  reason: string;
  verdict: 'all_pass' | 'any_fail';
  results: ReturnType<typeof evaluateDeterministic>['results'];
} | null {
  const criteriaParts: string[] = [];
  if (typeof input.rubric === 'string') criteriaParts.push(input.rubric);
  if (typeof input.expected === 'string') criteriaParts.push(input.expected);
  const criteria = criteriaParts.join('\n');
  if (criteria.trim().length === 0) return null;

  const outputText =
    typeof input.output === 'string' ? input.output : JSON.stringify(input.output ?? '');

  const det = evaluateDeterministic(criteria, outputText);
  if (det.verdict === 'inconclusive') return null;

  return {
    score: det.verdict === 'all_pass' ? 1 : 0,
    reason:
      det.verdict === 'all_pass'
        ? `Deterministic shape-check passed (${det.results.length} assertion(s)).\n${det.summary}`
        : `Deterministic shape-check failed.\n${det.summary}`,
    verdict: det.verdict,
    results: det.results,
  };
}