import { describe, it, expect } from 'vitest';
import {
  decompose,
  buildDecomposerSystemPrompt,
  buildDecomposerSystemPromptWithTaskModel,
  parseDecomposerOutput,
} from '../../src/brain/decomposer.js';
import { DagTaskSchema, DagSchema } from '../../src/types/schemas.js';
import type { Dag } from '../../src/types/index.js';

const VALID_KINDS = new Set([
  'llm_call',
  'cli_spawn',
  'http',
  'eval',
  'consolidate',
]);

function assertDagShape(dag: Dag): void {
  expect(dag.tasks.length).toBeGreaterThan(0);
  const ids = new Set(dag.tasks.map((t) => t.id));
  expect(ids.size).toBe(dag.tasks.length); // ids are unique
  for (const task of dag.tasks) {
    expect(task.id).toBeTruthy();
    expect(task.name).toBeTruthy();
    expect(VALID_KINDS.has(task.kind)).toBe(true);
    expect(Array.isArray(task.depends_on)).toBe(true);
    for (const dep of task.depends_on) {
      expect(ids.has(dep)).toBe(true); // every dep refers to a known id
    }
  }
}

// ─── DagTaskSchema — static Zod validation (no LLM required) ─────────────────

describe('DagTaskSchema — timeout_seconds field', () => {
  it('accepts timeout_seconds: 900 (within 60–1800 clamp)', () => {
    const result = DagTaskSchema.safeParse({
      id: 't1',
      name: 'Assembly Task',
      kind: 'cli_spawn',
      depends_on: [],
      timeout_seconds: 900,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_seconds).toBe(900);
    }
  });

  it('accepts omitted timeout_seconds (optional field — back-compat)', () => {
    const result = DagTaskSchema.safeParse({
      id: 't1',
      name: 'Task No Timeout',
      kind: 'llm_call',
      depends_on: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_seconds).toBeUndefined();
    }
  });

  it('rejects timeout_seconds below 60 (enforces min clamp)', () => {
    const result = DagTaskSchema.safeParse({
      id: 't1',
      name: 'Too Short',
      kind: 'llm_call',
      depends_on: [],
      timeout_seconds: 59,
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeout_seconds above 1800 (enforces max clamp)', () => {
    const result = DagTaskSchema.safeParse({
      id: 't1',
      name: 'Too Long',
      kind: 'llm_call',
      depends_on: [],
      timeout_seconds: 1801,
    });
    expect(result.success).toBe(false);
  });

  it('accepts DagSchema with a task that has timeout_seconds: 900', () => {
    const result = DagSchema.safeParse({
      tasks: [
        {
          id: 'a',
          name: 'Multi-component synthesis',
          kind: 'cli_spawn',
          depends_on: [],
          timeout_seconds: 900,
        },
        {
          id: 'b',
          name: 'Fast analysis',
          kind: 'llm_call',
          depends_on: ['a'],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0]!.timeout_seconds).toBe(900);
      expect(result.data.tasks[1]!.timeout_seconds).toBeUndefined();
    }
  });
});

// ─── SYSTEM_PROMPT heuristic content checks (no LLM required) ───────────────

describe('decomposer — SYSTEM_PROMPT heuristic labels', () => {
  // Use a dummy model ID — no model guidance lookup happens for unknown IDs
  const prompt = buildDecomposerSystemPrompt('cc/claude-sonnet-4-6');

  it('contains TIMEOUT HINTS heuristic label (H12)', () => {
    expect(prompt).toContain('TIMEOUT HINTS');
  });

  it('contains FALSIFIABLE ACCEPTANCE_CRITERIA heuristic label (H13)', () => {
    expect(prompt).toContain('FALSIFIABLE ACCEPTANCE_CRITERIA');
  });

  it('contains PARALLEL-TASK CONTRACT CONSISTENCY heuristic label (H14)', () => {
    expect(prompt).toContain('PARALLEL-TASK CONTRACT CONSISTENCY');
  });

  it('still contains all original heuristics H1 through H11 (regression guard)', () => {
    expect(prompt).toContain('H1 GRANULARITY');
    expect(prompt).toContain('H2 FAN-OUT');
    expect(prompt).toContain('H3 CRITICAL PATH');
    expect(prompt).toContain('H4 OUTPUT SCOPE');
    expect(prompt).toContain('H5 KIND BY NATURE');
    expect(prompt).toContain('H6 DOWNSTREAM SELECTORS');
    expect(prompt).toContain('H7 FALSIFIABLE CRITERIA');
    expect(prompt).toContain('H8 EXPLICIT REVIEWER');
    expect(prompt).toContain('H9 FAILURE MODE');
    expect(prompt).toContain('H10 MODEL ASSIGNMENT');
    expect(prompt).toContain('H11 PLAN GATE');
  });

  it('example DAG includes timeout_seconds field', () => {
    expect(prompt).toContain('"timeout_seconds"');
  });

  it('contains MULTI-MODEL DIVERSITY heuristic label (H15)', () => {
    expect(prompt).toContain('H15 MULTI-MODEL DIVERSITY');
  });

  it('contains NATIVE SUBAGENT DELEGATION heuristic label (H16)', () => {
    expect(prompt).toContain('H16 NATIVE SUBAGENT DELEGATION');
  });

  it('mentions at least two non-Claude model options (cx/gpt-5.4 and gemini-cli)', () => {
    expect(prompt).toContain('cx/gpt-5.4');
    expect(prompt).toContain('gemini-cli');
  });

  it('mentions pal:consensus executor hint', () => {
    expect(prompt).toContain('pal:consensus');
  });

  it('mentions at least three claude-code subagent_type values (Explore, code-reviewer, architect)', () => {
    expect(prompt).toContain('Explore');
    expect(prompt).toContain('code-reviewer');
    expect(prompt).toContain('architect');
  });

  it('contains EXAMPLE D (multi-model research workflow)', () => {
    expect(prompt).toContain('EXAMPLE D');
  });

  // R-CRITICAL Opus review (2026-04-23): SYSTEM_PROMPT must NOT reference
  // model IDs / PAL tool names that don't actually exist. Stale IDs cause
  // every workflow following the heuristic to fail at runtime with
  // model_not_found / tool_not_found.
  it('does NOT contain stale/invalid identifiers (regression guard)', () => {
    // gemini-3.7 was hallucinated; canonical is gemini-3.1-pro-preview
    expect(prompt).not.toContain('gemini-3.7');
    // kimi-coding/ is a legacy prefix; canonical is kmc/
    expect(prompt).not.toContain('kimi-coding/');
    // pal:deepthink is wrong; canonical is pal:thinkdeep (matches pal-mcp-server tool name)
    expect(prompt).not.toContain('pal:deepthink');
  });

  it('uses canonical model IDs from docs/08-AI-PROVIDER-MATRIX.csv', () => {
    expect(prompt).toContain('gemini-cli/gemini-3.1-pro-preview');
    expect(prompt).toContain('kmc/kimi-k2.5-thinking');
    expect(prompt).toContain('pal:thinkdeep');
  });
});

// Sprint F4 (model picker): builder that appends an operator override to the
// base system prompt. Critical correctness checks: the override section must
// only appear when a hint is set, and CLI hints must produce executor_hint
// guidance instead of model= guidance.
describe('decomposer — buildDecomposerSystemPromptWithTaskModel', () => {
  it('returns the base prompt unchanged when no hint is provided', () => {
    const base = buildDecomposerSystemPrompt('cc/claude-sonnet-4-6');
    const out = buildDecomposerSystemPromptWithTaskModel('cc/claude-sonnet-4-6', undefined);
    expect(out).toBe(base);
  });

  it('returns the base prompt unchanged when the hint is empty/whitespace', () => {
    const base = buildDecomposerSystemPrompt('cc/claude-sonnet-4-6');
    expect(buildDecomposerSystemPromptWithTaskModel('cc/claude-sonnet-4-6', '')).toBe(base);
    expect(buildDecomposerSystemPromptWithTaskModel('cc/claude-sonnet-4-6', '   ')).toBe(base);
  });

  it('appends an OPERATOR MODEL OVERRIDE section when an LLM model id is provided', () => {
    const out = buildDecomposerSystemPromptWithTaskModel(
      'cc/claude-sonnet-4-6',
      'cc/claude-opus-4-7',
    );
    expect(out).toContain('OPERATOR MODEL OVERRIDE');
    // Quoted in the instruction so the planner sees the exact id
    expect(out).toContain('"cc/claude-opus-4-7"');
    // For a non-CLI id we expect model= guidance (case-insensitive — prompt uses lowercase "assign model=")
    expect(out.toLowerCase()).toContain('assign model=');
  });

  it('emits executor_hint guidance for cli: prefixed hints (CLI binary)', () => {
    const out = buildDecomposerSystemPromptWithTaskModel(
      'cc/claude-sonnet-4-6',
      'cli:codex',
    );
    expect(out).toContain('OPERATOR MODEL OVERRIDE');
    expect(out).toContain('"cli:codex"');
    // CLI hints route through executor_hint, not model
    expect(out).toContain('executor_hint=');
  });

  it('preserves H10/H11/H15 references after the override (override AUGMENTS, never replaces)', () => {
    const out = buildDecomposerSystemPromptWithTaskModel(
      'cc/claude-sonnet-4-6',
      'cc/claude-opus-4-7',
    );
    expect(out).toContain('H10 MODEL ASSIGNMENT');
    expect(out).toContain('H11 PLAN GATE');
    expect(out).toContain('H15 MULTI-MODEL DIVERSITY');
  });
});

describe('decomposer — CLI/model routing normalization', () => {
  it('normalizes default-ish claude-code hints to cli:codex when a cli_spawn task uses a cx model', () => {
    const dag = parseDecomposerOutput(JSON.stringify({
      tasks: [
        {
          id: 't1',
          name: 'Implement feature',
          kind: 'cli_spawn',
          depends_on: [],
          executor_hint: 'cli:claude-code',
          model: 'cx/gpt-5.4',
          acceptance_criteria: 'File src/App.tsx exists with implementation.',
        },
      ],
    }));

    expect(dag.tasks[0]?.executor_hint).toBe('cli:codex');
    expect(dag.tasks[0]?.model).toBe('cx/gpt-5.4');
  });
});

// 45s per live call: LLM roundtrip via Omniroute + network + model latency.
const LIVE_TIMEOUT_MS = 45_000;

// Live LLM tests — gated on OMNIFORGE_LIVE_LLM_TESTS=true so CI / dev
// machines without Omniroute access don't fail. Run locally with:
//   OMNIFORGE_LIVE_LLM_TESTS=true pnpm vitest tests/unit/decomposer.test.ts
// Per AUDIT-2026-05-05.md §3 (user feedback "LLM custo zero pela assinatura"
// — opt-in instead of hardcoded skip so live runs are one env-flip away).
const RUN_LIVE_LLM = process.env['OMNIFORGE_LIVE_LLM_TESTS'] === 'true';

describe.skipIf(!RUN_LIVE_LLM)('decomposer — live against Omniroute', () => {
  it(
    'Fixture 1: linear chain (3 tasks in sequence)',
    async () => {
      const dag = await decompose(
        'Read a markdown file, count the number of words, and write the count to output.txt. Use exactly 3 sequential tasks.',
      );
      assertDagShape(dag);
      // Shape hint: at least one task with no deps, at least one with deps.
      const entry = dag.tasks.filter((t) => t.depends_on.length === 0);
      const dependent = dag.tasks.filter((t) => t.depends_on.length > 0);
      expect(entry.length).toBeGreaterThanOrEqual(1);
      expect(dependent.length).toBeGreaterThanOrEqual(1);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'Fixture 2: independent tasks (parallelism possible)',
    async () => {
      const dag = await decompose(
        'Fetch the latest headline from two different RSS feeds (BBC and Reuters). The two fetches are independent.',
      );
      assertDagShape(dag);
      // Shape hint: at least two entry tasks (independent).
      const entry = dag.tasks.filter((t) => t.depends_on.length === 0);
      expect(entry.length).toBeGreaterThanOrEqual(2);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'Fixture 3: convergence (fan-in into a final task)',
    async () => {
      const dag = await decompose(
        'Draft three separate sections of a report (intro, analysis, conclusion) in parallel, then consolidate them into a single final document.',
      );
      assertDagShape(dag);
      // Shape hint: there exists a task that depends on 2+ other tasks.
      const fanIn = dag.tasks.filter((t) => t.depends_on.length >= 2);
      expect(fanIn.length).toBeGreaterThanOrEqual(1);
    },
    LIVE_TIMEOUT_MS,
  );
});
