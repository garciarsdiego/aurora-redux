import type Database from 'better-sqlite3';
import type { Task, Workflow } from '../types/index.js';
import { insertEvent } from '../db/persist.js';
import { runCliTask } from '../executors/cli.js';
import type { DetectedProject } from './projectDetector.js';
import { getValidationCommand } from './projectDetector.js';
import {
  detectTestCommand,
  runTestCommandConstrained,
  type ConstrainedProfile,
} from './validation/test-runner.js';
import { scanForInjection } from '../v2/injection-scan/index.js';

/**
 * D35 — Final validation step (Consolidator 2.0).
 *
 * After all workflow tasks complete and before the prose consolidator runs,
 * this module attempts to verify the generated project actually compiles /
 * lints / passes its native validation gate. It delegates the work to a
 * claude-code cli_spawn so the agent can both RUN the check and FIX errors
 * it finds, up to `maxAttempts` times.
 *
 * Non-fatal by design: a failing validation does not fail the workflow —
 * it just records a metadata flag so the caller knows the output needs
 * manual review.
 */

export interface ValidationResult {
  passed: boolean;
  summary: string;
  attempts: number;
  /** stdout/stderr of the last cli invocation, truncated to 2k for the DB */
  lastOutput: string;
}

export interface ValidationOptions {
  /** Maximum fix-retry attempts (default 2) */
  maxAttempts?: number;
  /** Timeout per cli invocation in ms (default 5min) */
  perAttemptTimeoutMs?: number;
  /** Apply offline env flags to the constrained test run (default true). */
  networkOff?: boolean;
}

/** Result of the test self-fix loop. `ran` is false when no test command exists. */
export interface TestValidationResult extends ValidationResult {
  ran: boolean;
  command: string | null;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 300_000;

const OK_MARKER = 'VALIDATION OK';
const FAIL_MARKER = 'VALIDATION FAILED';

/**
 * Builds the claude-code prompt. Must be concrete and directive — the CLI
 * needs a clear success/failure marker to parse and a bounded work envelope.
 */
function buildValidationPrompt(
  project: DetectedProject,
  command: string,
  previousFailure: string | null,
): string {
  const lines = [
    `Validate the generated project at: ${project.rootDir}`,
    '',
    `Run this command and interpret its output:`,
    `    cd "${project.rootDir}" && ${command}`,
    '',
    'If it fails:',
    '  1. Read the error output carefully.',
    '  2. Edit the minimum files needed to fix the errors. Do NOT reshape the project.',
    '  3. Rerun the command.',
    '  4. Stop after at most 3 fix rounds inside this invocation.',
    '',
    'Respond with ONE of these final lines (nothing else on that line):',
    `  "${OK_MARKER}"                              — command exits 0 after any fixes`,
    `  "${FAIL_MARKER}: <one-sentence summary>"    — still failing or unfixable`,
    '',
    'The marker line MUST be the LAST line of your response.',
  ];

  if (previousFailure) {
    lines.push(
      '',
      'A previous attempt in this workflow already tried. That attempt reported:',
      `  "${previousFailure}"`,
      'Take a different approach this time.',
    );
  }

  return lines.join('\n');
}

/**
 * Parses the CLI output, looking for the OK / FAIL marker anchored at a
 * line boundary. Falls back to "failed, unparseable" if neither is present.
 */
export function parseValidationOutput(raw: string): {
  passed: boolean;
  summary: string;
} {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Search from the END — final line is the expected marker location
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === OK_MARKER) return { passed: true, summary: 'OK' };
    if (line.startsWith(FAIL_MARKER)) {
      const summary = line.slice(FAIL_MARKER.length).replace(/^[:\s]+/, '').trim();
      return { passed: false, summary: summary || 'no details' };
    }
  }

  return {
    passed: false,
    summary: 'validator did not emit a recognised marker (VALIDATION OK / FAILED)',
  };
}

/**
 * Constructs the synthetic Task object handed to runCliTask. runCliTask only
 * reads a small set of fields — the rest of Task is filled with safe defaults
 * since this task never gets persisted in the DB.
 */
function buildSyntheticTask(
  workflow: Workflow,
  prompt: string,
): Task {
  return {
    id: `__validator_${workflow.id}`,
    workflow_id: workflow.id,
    name: prompt,
    kind: 'cli_spawn',
    input_json: null,
    output_json: null,
    status: 'running',
    depends_on: [],
    executor_hint: 'cli:claude-code',
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

/**
 * Enforces a wall-clock timeout on a single runCliTask invocation. Mirrors
 * the executor's withTimeout pattern so tree-kill in cli.ts still fires.
 */
function withTimeoutSignal<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    factory(ac.signal).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

export async function runFinalValidation(
  db: Database.Database,
  workflow: Workflow,
  project: DetectedProject,
  opts: ValidationOptions = {},
): Promise<ValidationResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const perAttemptTimeoutMs =
    opts.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS;

  const command = getValidationCommand(project.type);
  if (!command) {
    // 'other' project type — nothing to validate. Not an error.
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_validation_skipped',
      payload: { reason: 'project_type_unsupported', project_type: project.type },
    });
    return {
      passed: true,
      summary: `skipped — project type '${project.type}' not validatable`,
      attempts: 0,
      lastOutput: '',
    };
  }

  insertEvent(db, {
    workflow_id: workflow.id,
    type: 'workflow_validation_started',
    payload: { project_type: project.type, root_dir: project.rootDir, command },
  });

  let previousFailureSummary: string | null = null;
  let lastOutput = '';
  let attempt = 0;

  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildValidationPrompt(project, command, previousFailureSummary);
    const syntheticTask = buildSyntheticTask(workflow, prompt);

    let cliOutput: string;
    try {
      cliOutput = await withTimeoutSignal(
        (signal) => runCliTask(syntheticTask, signal),
        perAttemptTimeoutMs,
        `validation_attempt_${attempt}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      insertEvent(db, {
        workflow_id: workflow.id,
        type: 'workflow_validation_error',
        payload: { attempt, error: msg },
      });
      previousFailureSummary = `cli invocation errored: ${msg}`;
      lastOutput = msg;
      continue;
    }

    lastOutput = cliOutput.slice(-2000);
    const parsed = parseValidationOutput(cliOutput);

    if (parsed.passed) {
      insertEvent(db, {
        workflow_id: workflow.id,
        type: 'workflow_validation_passed',
        payload: { attempt },
      });
      return {
        passed: true,
        summary: parsed.summary,
        attempts: attempt,
        lastOutput,
      };
    }

    // Failed — log and prepare next attempt
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_validation_failed',
      payload: { attempt, summary: parsed.summary },
    });
    previousFailureSummary = parsed.summary;
  }

  // All attempts exhausted
  insertEvent(db, {
    workflow_id: workflow.id,
    type: 'workflow_validation_exhausted',
    payload: { attempts: maxAttempts, final_summary: previousFailureSummary },
  });

  return {
    passed: false,
    summary: previousFailureSummary ?? 'unknown failure',
    attempts: maxAttempts,
    lastOutput,
  };
}

/**
 * Builds the coding-CLI fix prompt from a parsed test failure. The CLI agent
 * only FIXES (it does not run the tests — we do that ourselves under the
 * constrained profile and re-run after the agent finishes).
 */
function buildTestFixPrompt(
  project: DetectedProject,
  command: string,
  failureSummary: string,
): string {
  return [
    `The project's tests are FAILING at: ${project.rootDir}`,
    '',
    `Test command: ${command}`,
    '',
    'Failing output (failure-only excerpt):',
    failureSummary || '(no parsed detail — inspect by running the command)',
    '',
    'Fix the MINIMUM production code needed to make these tests pass.',
    'Do NOT edit the tests themselves unless a test is clearly, provably wrong.',
    'Do NOT reshape the project, add dependencies, or change unrelated files.',
    'Make the edits now — the test command will be re-run automatically after you finish.',
  ].join('\n');
}

/**
 * Aurora-parity Wave 1 — run the project's REAL tests under a constrained
 * profile (hard timeout + worktree cwd + network-off env) and self-correct in a
 * bounded loop: run tests → on failure, hand the parsed failure to the coding
 * CLI to fix → re-run. Non-fatal and bounded (token cost capped by maxAttempts).
 *
 * Skips cleanly (ran=false, passed=true) when no test command is detected or
 * DISABLE_TEST_VALIDATION=true. Unlike the build check, the test command is run
 * by US (constrained), not by the CLI agent — see test-runner.ts header for the
 * honest scope of "constrained" (timeout/cwd hard; network-off best-effort).
 */
export async function runTestValidation(
  db: Database.Database,
  workflow: Workflow,
  project: DetectedProject,
  opts: ValidationOptions = {},
): Promise<TestValidationResult> {
  const command = detectTestCommand(project.rootDir);
  if (!command) {
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_test_validation_skipped',
      payload: { reason: 'no_test_command', root_dir: project.rootDir },
    });
    return { passed: true, summary: 'skipped — no test command detected', attempts: 0, lastOutput: '', ran: false, command: null };
  }
  if (process.env['DISABLE_TEST_VALIDATION'] === 'true') {
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_test_validation_skipped',
      payload: { reason: 'disabled_by_env', command },
    });
    return { passed: true, summary: 'skipped — DISABLE_TEST_VALIDATION=true', attempts: 0, lastOutput: '', ran: false, command };
  }

  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS;
  const profile: ConstrainedProfile = { timeoutMs: perAttemptTimeoutMs, networkOff: opts.networkOff ?? true };

  insertEvent(db, {
    workflow_id: workflow.id,
    type: 'workflow_test_validation_started',
    payload: { command, root_dir: project.rootDir, max_attempts: maxAttempts },
  });

  let lastOutput = '';
  let lastSummary = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runTestCommandConstrained(project.rootDir, command, profile);
    lastOutput = result.output.slice(-2000);

    if (result.passed) {
      insertEvent(db, {
        workflow_id: workflow.id,
        type: 'workflow_test_validation_passed',
        payload: { attempt, command },
      });
      return { passed: true, summary: 'tests passed', attempts: attempt, lastOutput, ran: true, command };
    }

    lastSummary = result.failureSummary;
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_test_validation_failed',
      payload: { attempt, command, timed_out: result.timedOut, exit_code: result.exitCode, summary: lastSummary },
    });

    // No point spawning a fix on the final attempt — we wouldn't re-verify it.
    if (attempt >= maxAttempts) break;

    // Test output is repo-controlled and flows into the coding CLI's prompt;
    // scan it for prompt-injection first and withhold it if flagged (the CLI
    // can still re-run the command itself to inspect).
    const safeSummary = scanForInjection(lastSummary).safe
      ? lastSummary
      : '[test output withheld — flagged by the injection scanner; re-run the test command to inspect]';
    const prompt = buildTestFixPrompt(project, command, safeSummary);
    const syntheticTask = buildSyntheticTask(workflow, prompt);
    try {
      await withTimeoutSignal(
        (signal) => runCliTask(syntheticTask, signal),
        perAttemptTimeoutMs,
        `test_fix_attempt_${attempt}`,
      );
    } catch (err) {
      // The fix invocation errored/timed out — record it but still re-run the
      // tests next iteration (a partial fix may have helped).
      insertEvent(db, {
        workflow_id: workflow.id,
        type: 'workflow_test_validation_error',
        payload: { attempt, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  insertEvent(db, {
    workflow_id: workflow.id,
    type: 'workflow_test_validation_exhausted',
    payload: { attempts: maxAttempts, command, final_summary: lastSummary },
  });
  return { passed: false, summary: lastSummary || 'tests failed', attempts: maxAttempts, lastOutput, ran: true, command };
}
