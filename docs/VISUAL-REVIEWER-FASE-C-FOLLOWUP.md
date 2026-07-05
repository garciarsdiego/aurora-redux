# Visual Reviewer — FASE C — Follow-up notes

Status: items 1-3 done, item 4 (per-task dispatch) **wired**, not just documented —
see `src/quality/task-visual-gate.ts` and its plug-in point in
`src/brain/executor/run-task/quality-gate.ts`. This file records the scope
decisions and a few precise loose ends for later hardening.

## What item 4 actually does

`attemptTaskVisualGate` (src/quality/task-visual-gate.ts) is called from
`runQualityGate` (src/brain/executor/run-task/quality-gate.ts:24-49) BEFORE
the existing `enforceLightTaskQualityReview` path. It is a strict
opt-in/fail-open pre-check:

- Returns `null` (falls through to the unchanged existing path) unless the
  task has `reviewer_profile === 'visual'` AND declares at least one
  `canvasRegionChecks`/`interactionChecks` entry AND the workflow has a
  resolvable `ArchitectureContract.projectRoot` (via
  `loadArchitectureContractForWorkflow`) AND the harness itself doesn't
  report `status: 'skipped'` (e.g. Playwright not installed).
- When the deterministic checks FAIL, it returns a rejected
  `QualityReviewRow` (`reviewerKind: 'browser_harness'`,
  `reviewerModel: 'playwright_deterministic'`) citing the specific failing
  check(s) by label — zero LLM calls made to reach that outcome.
- When the deterministic checks PASS, it returns `null` too — the existing
  LLM-backed light review still runs as an additional layer. Only the
  failure path short-circuits LLM spend, per the FASE C brief ("os checks
  determinísticos decidem antes de qualquer LLM" — read as "before/instead
  of LLM in the failure case", not "instead of ever running the LLM").

`quality-gate.ts` treats a rejected visual-gate review the same way it
already treats a rejected `enforceLightTaskQualityReview` result: in
`enforced` mode it calls `setTaskFailed` + throws `QualityGateFailedError`
(same error type, same auto-fix-task creation path downstream in
`success-finalize.ts`/`run-task.ts` — untouched); in `dry-run` mode it just
returns the review row without failing the task.

## Why this was judged safe to wire (not just document)

- The hardened path (`enforceLightTaskQualityReview` /
  `runLightTaskQualityReview`) is **not modified at all** — not one line
  inside it changed. The new branch is a pure "return early" guard placed
  before the existing `try { … enforceLightTaskQualityReview … }` block.
- `attemptTaskVisualGate` cannot itself throw into the caller:
  `attemptTaskVisualGateSafely` wraps it in try/catch and treats any
  internal error as "gate does not apply" (`null`), logging a
  `task_visual_gate_error` event instead of propagating.
- `reviewer_profile` was previously **inert** at runtime — grep before this
  change showed it was accepted by `DagSchema`/pinned by
  `dag-validator-reviewer-profile.test.ts`, but never read anywhere except
  a doc comment ("the reviewer dispatcher applies the actual scoring
  policy" — that dispatcher didn't exist yet). There was no existing
  behavior on this field to regress.
- Confirmed via `tests/unit/executor-quality-gate-visual.test.ts`: a task
  with `reviewer_profile: 'visual'` but no contract/checks in the DB (the
  common case in the existing lightweight in-memory executor tests) falls
  through to the exact same enforced-gate behavior as before, byte for byte
  (same events, same task status).

## Precise loose ends for future hardening (not blocking, but real)

1. **`reviewer_profile` has no dedicated `tasks` table column.** Like
   several other DAG-only fields (`print_template`, `if_condition`, etc. —
   see the comment at `src/brain/executor/internal-utils.ts:80-93`), it is
   persisted inside `input_json` only. `src/brain/executor/orchestrate.ts`
   materialises it onto the in-memory `Task.reviewer_profile` at DAG->Task
   time (line ~830, mirroring `execution_mode`) for same-process reads, but
   `rowToTask` (`src/db/persist.ts:34-44`) does **not** hydrate it back out
   of `input_json` on reload (unlike the deterministic-kind hydrator
   `hydrateDeterministicArgsFromInputJson`, which only covers
   `if_else`/`switch`/`loop`/etc. kinds, not `reviewer_profile`).
   `attemptTaskVisualGate`'s own `readTaskVisualConfig` works around this by
   reading `task.reviewer_profile ?? JSON.parse(task.input_json).reviewer_profile`
   directly, so the gate itself is resume-safe — but no other future
   consumer of `Task.reviewer_profile` gets this fallback for free. If a
   second consumer needs `reviewer_profile` beyond the quality gate, either
   add a real `tasks.reviewer_profile` column (migration) or extend
   `hydrateDeterministicArgsFromInputJson` to also restore it for all task
   kinds (not just the deterministic ones).

2. **No decomposer LLM prompt teaches `reviewer_profile: 'visual'` yet.**
   `src/brain/decomposer.ts` does not mention `reviewer_profile` at all —
   the field has always been a manual/programmatic DAG author's opt-in, not
   something the decomposition LLM currently emits on its own. Teaching the
   decomposer prompt when to set `reviewer_profile: 'visual'` +
   `canvasRegionChecks`/`interactionChecks` (e.g. "this task renders a
   canvas game scene" or "this task adds a keyboard-driven interaction") is
   out of scope here and would be its own follow-up.

3. **Per-task harness runs use the workflow-level `ArchitectureContract`,
   not a per-task project root.** `loadArchitectureContractForWorkflow`
   returns the first `architecture_contract` decision recorded for the
   *workflow*, not anything task-scoped. For the common case (one app,
   many tasks) this is correct and matches how the final-gate harness
   (item 3) already resolves `projectRoot`. A workflow that legitimately
   builds multiple independent apps in one DAG would need a per-task
   project-root override — no such DAG shape exists in this codebase today,
   so it wasn't built.

4. **`attemptTaskVisualGate` spawns a fresh dev server + Chromium launch per
   visual task**, same cost profile as the existing final-gate Playwright
   harness (item 3/F6-2), just invoked once per opted-in task instead of
   once per workflow. For a DAG with many `reviewer_profile: 'visual'`
   tasks this means N dev-server spawns. No batching/reuse-across-tasks
   optimization was attempted — correctness and safety were prioritized
   over performance for this first wiring pass. A future optimization could
   thread a single already-running harness/page through multiple task
   checks in the same workflow run.

5. **(M7) Split `src/quality/playwright-product-harness.ts` (>800 lines).**
   Deferred from the FASE C review. Suggested split: extract the canvas
   region-check logic into `src/quality/canvas-region.ts` and the
   interaction-check logic into `src/quality/interaction.ts`, leaving the
   harness file to own only dev-server spawn/teardown + Playwright driving.
   Left as follow-up to avoid churning the just-hardened file.

## Files touched for item 4

- `src/quality/task-visual-gate.ts` (new)
- `src/brain/executor/run-task/quality-gate.ts` (wiring)
- `tests/unit/task-visual-gate.test.ts` (new)
- `tests/unit/executor-quality-gate-visual.test.ts` (new, regression proof)
