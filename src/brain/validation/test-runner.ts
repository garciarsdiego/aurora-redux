// Aurora-parity Wave 1 — constrained test-runner.
//
// Turns Omniforge from a "compiles?" checker into a "passes its own tests?"
// coding agent. Detects a project's REAL test command and runs it as a
// constrained subprocess (hard timeout + worktree-confined cwd + best-effort
// network-off), then parses a failure-only summary that the self-fix loop in
// validator.ts feeds back to the coding CLI.
//
// CONSTRAINED PROFILE — honest scope on Windows/cross-platform:
//   - Hard timeout: ENFORCED (tree-kill the whole process tree on expiry).
//   - cwd confinement: ENFORCED (spawned in the task's worktree).
//   - Network-off: BEST-EFFORT via offline env flags (npm/pip/cargo/go). True
//     network isolation needs the per-task container sandbox that the parity
//     plan explicitly DEFERS — documented, not faked.
// The test command is a fixed value produced by detectTestCommand (never
// interpolated with untrusted input), so `shell: true` here carries no injection
// vector; it is required for cross-platform resolution of `.cmd` shims (pnpm/npx).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import treeKill from 'tree-kill';

export interface ConstrainedProfile {
  /** Hard wall-clock cap; the process tree is killed on expiry. */
  timeoutMs: number;
  /** Apply offline env flags (best-effort network suppression). Default true. */
  networkOff: boolean;
}

export const DEFAULT_TEST_PROFILE: ConstrainedProfile = {
  timeoutMs: 300_000,
  networkOff: true,
};

export interface TestRunResult {
  /** false when no test command could be detected (skip, not a failure). */
  ran: boolean;
  passed: boolean;
  command: string | null;
  /** captured stdout+stderr, tail-truncated for the DB. */
  output: string;
  /** failure-only summary (empty when passed). */
  failureSummary: string;
  timedOut: boolean;
  exitCode: number | null;
}

const MAX_OUTPUT = 16_000;

// Offline-discouraging env. Best-effort only (see header). Never sets a fake
// proxy — that risks hangs that look like real failures.
const NETWORK_OFF_ENV: Record<string, string> = {
  npm_config_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  PIP_NO_INDEX: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  CARGO_NET_OFFLINE: 'true',
  GOPROXY: 'off',
};

/**
 * Detect the project's real test command from on-disk markers. Marker-based
 * (not just project-type) so cargo/go are covered even when the generic type
 * detector returns 'other'. Returns null when there is nothing meaningful to
 * run (so the caller skips cleanly rather than inventing a command).
 */
function fileContains(filePath: string, pattern: RegExp): boolean {
  try {
    return pattern.test(readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}

export function detectTestCommand(rootDir: string): string | null {
  if (!rootDir || !existsSync(rootDir)) return null;

  // Rust / Go — unambiguous manifest markers.
  if (existsSync(join(rootDir, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(rootDir, 'go.mod'))) return 'go test ./...';

  // Node ecosystem.
  const pkgPath = join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const testScript = pkg.scripts?.['test'];
      const isRealTestScript =
        typeof testScript === 'string' &&
        testScript.trim().length > 0 &&
        !/no test specified/i.test(testScript);
      if (isRealTestScript) {
        const pm = existsSync(join(rootDir, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(join(rootDir, 'yarn.lock'))
            ? 'yarn'
            : 'npm';
        return `${pm} test`;
      }
      // No test script, but a known runner is installed → invoke it directly.
      const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
      if (deps['vitest']) return 'npx vitest run';
      if (deps['jest']) return 'npx jest';
      return null;
    } catch {
      return null;
    }
  }

  // Python — require a real pytest indicator, not just any python project, so a
  // Poetry/unittest project (or a bare tests/ dir without pytest) doesn't trip a
  // wasted run + fix attempt on a tool that isn't even configured/installed.
  if (existsSync(join(rootDir, 'pytest.ini')) || existsSync(join(rootDir, 'conftest.py'))) {
    return 'python -m pytest -q';
  }
  const hasPytestConfig =
    (existsSync(join(rootDir, 'pyproject.toml')) && fileContains(join(rootDir, 'pyproject.toml'), /\[tool\.pytest/)) ||
    (existsSync(join(rootDir, 'setup.cfg')) && fileContains(join(rootDir, 'setup.cfg'), /\[tool:pytest\]/)) ||
    (existsSync(join(rootDir, 'tests')) && existsSync(join(rootDir, 'tests', 'conftest.py')));
  if (hasPytestConfig) return 'python -m pytest -q';

  return null;
}

/**
 * Heuristic failure-only summary (rtk-style): keep lines that look like test
 * failures; fall back to the output tail when no markers match. Bounded so a
 * 50k-line log doesn't blow up the fix prompt or the DB row.
 */
export function parseTestFailures(output: string): string {
  const lines = output.split(/\r?\n/);
  const marker = /(\bFAIL(ED|ING)?\b|✗|×|\bError:|AssertionError|\bpanic:|^not ok |\d+\s+(failed|failing|error)|Test Files\b.*\bfailed|\bExpected\b.*\bReceived\b)/i;
  const hits = lines.map((l) => l.trim()).filter((l) => l.length > 0 && marker.test(l));
  const chosen = hits.length > 0 ? hits.slice(0, 25) : lines.map((l) => l.trim()).filter(Boolean).slice(-25);
  return chosen.join('\n').slice(0, 2_000);
}

/**
 * Run `command` in `rootDir` under the constrained profile. Resolves (never
 * rejects) with a structured result — a spawn error or timeout is a graded
 * failure, not a thrown exception, so the caller's loop stays simple.
 */
export function runTestCommandConstrained(
  rootDir: string,
  command: string,
  profile: ConstrainedProfile = DEFAULT_TEST_PROFILE,
): Promise<TestRunResult> {
  return new Promise<TestRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(profile.networkOff ? NETWORK_OFF_ENV : {}),
    };
    // shell:true — command is a fixed detected string (no untrusted interpolation);
    // needed for cross-platform .cmd resolution. cwd confines side effects.
    const child = spawn(command, {
      cwd: rootDir,
      shell: true,
      env,
      windowsHide: true,
    });

    let output = '';
    let timedOut = false;
    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) treeKill(child.pid, 'SIGKILL');
    }, profile.timeoutMs);

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        passed: false,
        command,
        output: `${output}\n${err.message}`,
        failureSummary: `failed to spawn test command: ${err.message}`,
        timedOut,
        exitCode: null,
      });
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const passed = !timedOut && code === 0;
      const failureSummary = passed
        ? ''
        : timedOut
          ? `test run exceeded ${profile.timeoutMs}ms and was killed`
          : parseTestFailures(output);
      resolve({ ran: true, passed, command, output, failureSummary, timedOut, exitCode: code });
    });
  });
}
