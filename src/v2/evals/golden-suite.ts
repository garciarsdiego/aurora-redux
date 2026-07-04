import type Database from 'better-sqlite3';
import type { Dag } from '../../types/index.js';
import { validateDag } from '../../brain/dag-validator.js';
import { evaluateToolPolicy, parseToolPolicySpec } from '../governance/policy-engine.js';
import { scanTextForSecrets } from '../security/secret-scan.js';
import {
  listEvalCases,
  loadEvalResults,
  registerEvalCase,
  runEvalSuite,
  type EvalCase,
  type EvalResult,
  type EvalRun,
  type JudgeResult,
} from './harness.js';

export interface GoldenEvalCaseDefinition {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  tags: string[];
}

export interface GoldenEvalReport {
  run: EvalRun;
  results: EvalResult[];
  threshold: number;
  passed: boolean;
}

export const DEFAULT_GOLDEN_EVAL_CASES: GoldenEvalCaseDefinition[] = [
  {
    name: 'dag-linear-validates',
    input: {
      kind: 'dag_validate',
      dag: {
        tasks: [
          { id: 't0', name: 'Gather context', kind: 'llm_call', depends_on: [] },
          { id: 't1', name: 'Write synthesis', kind: 'llm_call', depends_on: ['t0'] },
        ],
      },
    },
    expected: { ok: true, taskCount: 2, errorRules: [] },
    tags: ['golden', 'ci', 'dag'],
  },
  {
    name: 'dag-missing-dependency-rejected',
    input: {
      kind: 'dag_validate',
      dag: {
        tasks: [
          { id: 't0', name: 'Broken task', kind: 'llm_call', depends_on: ['missing'] },
        ],
      },
    },
    expected: { ok: false, taskCount: 1, errorRules: ['graph-integrity'] },
    tags: ['golden', 'ci', 'dag', 'failure'],
  },
  {
    name: 'tool-policy-approval-required',
    input: {
      kind: 'tool_policy',
      policy: {
        tools: {
          allowed: ['file-write'],
          require_approval_for: ['file-write'],
        },
      },
      toolName: 'file-write',
    },
    expected: {
      allowed: false,
      requiresApproval: true,
      reason: "tool 'file-write' requires human approval by policy",
    },
    tags: ['golden', 'ci', 'governance'],
  },
  {
    name: 'secret-scan-hardcoded-omniroute-key',
    input: {
      kind: 'secret_scan',
      envName: 'OMNIROUTE_API_KEY',
      secretParts: ['sk', '68e31a43c24d23f3', 'b33326eca9a4c7'],
    },
    expected: { count: 1, ruleIds: ['omniroute-api-key'] },
    tags: ['golden', 'ci', 'security'],
  },
];

export async function runGoldenEvalSuite(
  db: Database.Database,
  options: {
    workspace?: string;
    suiteName?: string;
    threshold?: number;
  } = {},
): Promise<GoldenEvalReport> {
  const workspace = options.workspace ?? 'ci';
  const threshold = options.threshold ?? 1;
  ensureGoldenEvalCases(db, workspace);

  const run = await runEvalSuite(db, {
    workspace,
    suiteName: options.suiteName ?? 'golden-ci',
    tags: ['golden', 'ci'],
    runner: runGoldenCase,
    judge: exactJsonJudge,
  });
  const results = loadEvalResults(db, run.id);
  const passed = run.score >= threshold && results.every((result) => result.status === 'passed');
  return { run, results, threshold, passed };
}

function ensureGoldenEvalCases(db: Database.Database, workspace: string): void {
  const existing = new Set(listEvalCases(db, { workspace }).map((testCase) => testCase.name));
  for (const testCase of DEFAULT_GOLDEN_EVAL_CASES) {
    if (existing.has(testCase.name)) continue;
    registerEvalCase(db, {
      workspace,
      name: testCase.name,
      input: testCase.input,
      expected: testCase.expected,
      tags: testCase.tags,
    });
  }
}

async function runGoldenCase(testCase: EvalCase): Promise<Record<string, unknown>> {
  const input = asRecord(testCase.input);
  const kind = String(input['kind'] ?? '');
  if (kind === 'dag_validate') {
    const dag = input['dag'] as Dag;
    const result = validateDag(dag);
    return {
      ok: !result.issues.some((issue) => issue.severity === 'error'),
      taskCount: Array.isArray(dag.tasks) ? dag.tasks.length : 0,
      errorRules: result.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.rule)
        .sort(),
    };
  }
  if (kind === 'tool_policy') {
    const decision = evaluateToolPolicy(parseToolPolicySpec(input['policy']), {
      toolName: String(input['toolName']),
      workspace: testCase.workspace,
      workflowId: 'golden-eval',
    });
    return {
      allowed: decision.allowed,
      requiresApproval: decision.requiresApproval === true,
      reason: decision.reason,
    };
  }
  if (kind === 'secret_scan') {
    const envName = String(input['envName']);
    const secretParts = Array.isArray(input['secretParts'])
      ? input['secretParts'].map(String)
      : [];
    const secret = secretParts.join('-');
    const findings = scanTextForSecrets(`${envName}=${secret}`, 'golden.env');
    return {
      count: findings.length,
      ruleIds: findings.map((finding) => finding.ruleId).sort(),
    };
  }
  throw new Error(`Unknown golden eval kind: ${kind}`);
}

async function exactJsonJudge(params: {
  output: unknown;
  expected: unknown;
}): Promise<JudgeResult> {
  const actual = stableJson(params.output);
  const expected = stableJson(params.expected);
  const passed = actual === expected;
  return {
    passed,
    score: passed ? 1 : 0,
    feedback: passed ? 'exact golden match' : `expected ${expected}; got ${actual}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Golden eval input must be an object');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}
