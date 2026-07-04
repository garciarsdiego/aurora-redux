/**
 * Deterministic judges for evaluation.
 *
 * These judges perform exact or pattern-based matching without LLM calls.
 * They are fast, deterministic, and cost-free.
 */

import { z } from 'zod';
import type { Judge, JudgeInput, JudgeOutput } from '../types.js';

/**
 * Exact match judge - compares output to expected exactly.
 *
 * Supports:
 * - String comparison (case-sensitive by default)
 * - JSON deep equality (when both are objects/arrays)
 * - Optional case-insensitive mode for strings
 */
export class ExactMatchJudge implements Judge {
  readonly name = 'exact-match';
  readonly version = 'v1';

  constructor(private readonly options: { caseSensitive?: boolean } = {}) {}

  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    const start = Date.now();

    try {
      const { output, expected } = input;
      let match = false;

      // JSON comparison for objects/arrays
      if (
        typeof output === 'object' &&
        output !== null &&
        typeof expected === 'object' &&
        expected !== null
      ) {
        match = JSON.stringify(output) === JSON.stringify(expected);
      }
      // String comparison
      else if (typeof output === 'string' && typeof expected === 'string') {
        match = this.options.caseSensitive !== false
          ? output === expected
          : output.toLowerCase() === expected.toLowerCase();
      }
      // Direct equality for primitives
      else {
        match = output === expected;
      }

      const score = match ? 1 : 0;
      const reason = match
        ? 'Output matches expected exactly'
        : `Output does not match expected. Got: ${JSON.stringify(output)}, Expected: ${JSON.stringify(expected)}`;

      return {
        score,
        reason,
        raw: JSON.stringify({ match, output, expected }),
        cost_usd: 0,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    } catch (error) {
      return {
        score: 0,
        reason: `Error during exact match evaluation: ${error instanceof Error ? error.message : String(error)}`,
        raw: JSON.stringify({ error: String(error) }),
        cost_usd: 0,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    }
  }
}

/**
 * Regex match judge - matches output against a regex pattern.
 *
 * The rubric should contain the regex pattern. If the rubric is not a valid regex,
 * it will be treated as a literal string to match.
 */
export class RegexMatchJudge implements Judge {
  readonly name = 'regex-match';
  readonly version = 'v1';

  constructor(private readonly options: { caseInsensitive?: boolean } = {}) {}

  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    const start = Date.now();

    try {
      const { output, rubric } = input;
      const outputStr = String(output);

      // Try to parse rubric as regex
      let regex: RegExp;
      try {
        const flags = this.options.caseInsensitive !== false ? 'i' : '';
        regex = new RegExp(rubric, flags);
      } catch {
        // If rubric is not a valid regex, treat as literal string
        const pattern = this.options.caseInsensitive !== false
          ? rubric.toLowerCase()
          : rubric;
        const searchStr = this.options.caseInsensitive !== false
          ? outputStr.toLowerCase()
          : outputStr;
        const match = searchStr.includes(pattern);

        return {
          score: match ? 1 : 0,
          reason: match
            ? `Output contains pattern "${rubric}"`
            : `Output does not contain pattern "${rubric}"`,
          raw: JSON.stringify({ match, pattern: rubric, output: outputStr }),
          cost_usd: 0,
          latency_ms: Date.now() - start,
          cache_hit: false,
        };
      }

      const match = regex.test(outputStr);

      return {
        score: match ? 1 : 0,
        reason: match
          ? `Output matches regex pattern "${rubric}"`
          : `Output does not match regex pattern "${rubric}"`,
        raw: JSON.stringify({ match, pattern: rubric, output: outputStr }),
        cost_usd: 0,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    } catch (error) {
      return {
        score: 0,
        reason: `Error during regex match evaluation: ${error instanceof Error ? error.message : String(error)}`,
        raw: JSON.stringify({ error: String(error) }),
        cost_usd: 0,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    }
  }
}

/**
 * Schema match judge - validates output against a Zod schema.
 *
 * The rubric should be a JSON string representing a Zod schema definition.
 * Supported schema types:
 * - Primitives: "string", "number", "boolean", "null"
 * - Objects: { type: "object", properties: { ... }, required?: [...] }
 * - Arrays: { type: "array", items: ... }
 * - Enums: { type: "enum", values: [...] }
 *
 * Example rubric (JSON string):
 * ```json
 * {
 *   "type": "object",
 *   "properties": {
 *     "name": { "type": "string" },
 *     "age": { "type": "number" }
 *   },
 *   "required": ["name", "age"]
 * }
 * ```
 */
export class SchemaMatchJudge implements Judge {
  readonly name = 'schema-match';
  readonly version = 'v1';

  constructor(private readonly schema?: z.ZodSchema<any>) {}

  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    const start = Date.now();

    try {
      const { output, rubric } = input;

      // Use provided schema or parse from rubric
      let schema: z.ZodSchema<any>;
      if (this.schema) {
        schema = this.schema;
      } else {
        schema = this.parseSchemaDefinition(rubric);
      }

      const result = schema.safeParse(output);

      if (result.success) {
        return {
          score: 1,
          reason: 'Output matches the expected schema',
          raw: JSON.stringify({ valid: true, output }),
          cost_usd: 0,
          latency_ms: Date.now() - start,
          cache_hit: false,
        };
      } else {
        const errorDetails = result.error.issues.map((e) => ({
          path: e.path.map(String).join('.'),
          message: e.message,
        }));

        return {
          score: 0,
          reason: `Output does not match schema: ${JSON.stringify(errorDetails)}`,
          raw: JSON.stringify({ valid: false, errors: errorDetails, output }),
          cost_usd: 0,
          latency_ms: Date.now() - start,
          cache_hit: false,
        };
      }
    } catch (error) {
      return {
        score: 0,
        reason: `Error during schema match evaluation: ${error instanceof Error ? error.message : String(error)}`,
        raw: JSON.stringify({ error: String(error) }),
        cost_usd: 0,
        latency_ms: Date.now() - start,
        cache_hit: false,
      };
    }
  }

  /**
   * Parse a schema definition from the rubric.
   */
  private parseSchemaDefinition(rubric: string): z.ZodSchema<any> {
    let definition: unknown;
    try {
      definition = JSON.parse(rubric);
    } catch {
      throw new Error('Rubric must be a valid JSON string representing a schema definition');
    }

    if (typeof definition !== 'object' || definition === null) {
      throw new Error('Schema definition must be an object');
    }

    return this.buildZodSchema(definition as Record<string, unknown>);
  }

  /**
   * Build a Zod schema from a definition object.
   */
  private buildZodSchema(def: Record<string, unknown>): z.ZodSchema<any> {
    const type = def.type as string;

    switch (type) {
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'boolean':
        return z.boolean();
      case 'null':
        return z.null();
      case 'enum':
        if (!Array.isArray(def.values)) {
          throw new Error('Enum schema must have a "values" array');
        }
        return z.enum(def.values as [string, ...string[]]);
      case 'array':
        if (!def.items) {
          throw new Error('Array schema must have an "items" definition');
        }
        return z.array(this.buildZodSchema(def.items as Record<string, unknown>));
      case 'object': {
        if (!def.properties || typeof def.properties !== 'object') {
          throw new Error('Object schema must have a "properties" object');
        }

        const shape: Record<string, z.ZodSchema<any>> = {};
        for (const [key, value] of Object.entries(def.properties as Record<string, unknown>)) {
          shape[key] = this.buildZodSchema(value as Record<string, unknown>);
        }

        const required = Array.isArray(def.required) ? def.required as string[] : [];
        for (const key of required) {
          if (shape[key]) {
            shape[key] = shape[key].optional();
          }
        }

        return z.object(shape);
      }
      default:
        throw new Error(`Unsupported schema type: ${type}`);
    }
  }
}