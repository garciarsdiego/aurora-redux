import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// P3 test-harness stability: cap fork-pool parallelism so we keep the speedup
// of parallel forks (dropping `maxWorkers: 1` fixed the old 109 child-death
// failures — see the long note below) WITHOUT oversubscribing the box. The
// occasional "Worker exited unexpectedly" flake on the full suite traces to
// fork oversubscription on high-core Windows runners: dozens of forks, each
// opening a native better-sqlite3 WAL connection, can exhaust file handles /
// memory and the OS reaps a worker mid-run. Bounding maxForks to ~half the
// cores (floor 2) keeps wide parallelism while leaving headroom for the
// native SQLite handles each fork holds. CI may override via VITEST_MAX_FORKS.
const MAX_FORKS = Math.max(
  2,
  Number(process.env.VITEST_MAX_FORKS) || Math.floor((os.cpus()?.length ?? 4) / 2),
);

// Sprint 5.1 (D-H2.066): vitest config with per-file environment selection.
//
// Default = node (fast, what most server-side tests use).
// JSDOM is opted-in per-file via the `// @vitest-environment jsdom` pragma
// at the top of the test file. Setup file extends expect with jest-dom
// matchers when JSDOM is active.
//
// 2026-05-05 (post-audit B7): kept `pool: 'forks'` (default) but DROPPED the
// `maxWorkers: 1` constraint. The fork+sequential combo was the source of
// ~109 child-process death failures on the full suite (see AUDIT-2026-05-05
// §4 item 3); making fork-pool parallel resolves the bottleneck while
// preserving fork-pool isolation that 3 tests rely on (those use
// process.chdir, which is unsupported in `pool: 'threads'` worker threads —
// see Node worker_threads docs). When/if the chdir tests get refactored
// (AUDIT §4 P2 backlog), this can switch to `pool: 'threads'` for
// additional speedup. Today: parallel forks > sequential forks > threads
// (because threads break chdir tests).

export default defineConfig({
  plugins: [react()],
  // Dashboard v2 uses `@/` imports. Unit tests that exercise v2 screens rely
  // on this alias (no second tsconfig for tests).
  resolve: {
    alias: {
      '@': path.join(repoRoot, 'apps/dashboard-v2/src'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    // P3 test-harness stability: bound fork-pool width to avoid the occasional
    // "Worker exited unexpectedly" caused by fork oversubscription (each fork
    // holds a native better-sqlite3 WAL handle; too many at once exhausts OS
    // resources and a worker gets reaped). This is the middle ground between
    // the slow sequential `--maxWorkers=1` legacy path and unbounded parallel
    // forks. See MAX_FORKS above. minForks is left at the vitest default.
    poolOptions: {
      forks: {
        maxForks: MAX_FORKS,
      },
    },
    testTimeout: 15000,
    hookTimeout: 15000,
    // Each test file gets a fresh module graph. Disabling isolation would
    // shave ~30% off cold start but breaks tests that mutate module-level
    // singletons (event broker, in-memory DB connections). Keep isolated.
    isolate: true,
    // Wave 3 (M1-W3-C): give known-flaky tests one retry. Configured at the
    // global level because vitest does not yet support per-pattern retry
    // policies. Individual flaky tests should still be tracked in
    // docs/notes/flaky-tests.md and rooted-out, not relied on for retries.
    // Targets: busy-timeout-retry, cancel-propagation, sqlite-busy-retry,
    // and a handful of timing-sensitive cli-tail probes.
    retry: 1,
    // Coverage stays opt-in: pass `--coverage` on the CLI to enable.
    // v8 is faster than istanbul; html report is for local triage; json-summary
    // is the artifact CI uploads.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}', 'apps/dashboard-v2/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/node_modules/**',
        '**/dist/**',
        'src/db/migrations/**',
      ],
      // No threshold enforcement yet (M1-W3-C is visibility only).
      thresholds: undefined,
    },
    // Exclude workflow-run snapshots and cleanup artifacts that vitest would
    // otherwise treat as live test files. Two trees host frozen copies of
    // `tests/` against older `src/` layouts:
    //   - `workspaces/<ws>/runs/<wfId>/` — per-workflow run dirs
    //   - `data/worktrees/<ws>/<wfId>/`  — per-workflow git worktrees
    // Both produce hundreds of stale failures without telling us anything new.
    // Also exclude `.claude/worktrees/**` for the same reason in main repo
    // (per-cluster worktrees from waves Onda 2-5).
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/workspaces/**/runs/**',
      '**/data/worktrees/**',
      '**/.claude/worktrees/**',
      '**/tests/e2e/**',
    ],
  },
});
