import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { initDb } from '../../src/db/client.js';
import { insertEvent, insertTask } from '../../src/db/persist.js';
import { getDbPath } from '../../src/utils/config.js';
import { saveQualityReview } from '../../src/quality/store.js';
import { openDashboard } from './_helpers';

const RUNNING_WORKFLOW_ID = 'wf_e2e_controls_running';
const PAUSED_WORKFLOW_ID = 'wf_e2e_controls_paused';
const DRAFT_ID = 'draft_e2e_controls';
const RUN_TARGET_WORKSPACE = 'dogfood-existing-code-e2e';
const RUN_TARGET_ROOT = resolve(process.cwd(), 'data', 'e2e-existing-code-target');

function upsertWorkflowFixture(
  db: ReturnType<typeof initDb>,
  id: string,
  status: string,
  objective: string,
  now: number,
) {
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, pattern_id, status, started_at, completed_at,
        created_at, created_by, estimated_cost_usd, actual_cost_usd,
        max_total_cost_usd, max_duration_seconds, metadata)
     VALUES (?, 'internal', ?, NULL, ?, ?, NULL, ?, 'e2e', NULL, NULL, NULL, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace = excluded.workspace,
       objective = excluded.objective,
       status = excluded.status,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       created_at = excluded.created_at,
       created_by = excluded.created_by,
       metadata = excluded.metadata`,
  ).run(id, objective, status, now - 10_000, now, JSON.stringify({ e2e: true }));
}

function seedWorkflowControlsFixtures() {
  const db = initDb(getDbPath());
  const now = Date.now();
  const workflowIds = [RUNNING_WORKFLOW_ID, PAUSED_WORKFLOW_ID];
  try {
    mkdirSync(RUN_TARGET_ROOT, { recursive: true });
    db.prepare(
      `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
       VALUES ('internal', ?, 'e2e', '{}')
       ON CONFLICT(name) DO NOTHING`,
    ).run(now);
    db.prepare(
      `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
       VALUES (?, ?, 'e2e', ?)
       ON CONFLICT(name) DO UPDATE SET metadata_json = excluded.metadata_json`,
    ).run(
      RUN_TARGET_WORKSPACE,
      now,
      JSON.stringify({
        software_target: {
          project_root: RUN_TARGET_ROOT,
          cwd: RUN_TARGET_ROOT,
          base_ref: 'HEAD',
        },
      }),
    );

    db.prepare(
      `DELETE FROM runtime_stream_events WHERE workflow_id IN (?, ?)`,
    ).run(...workflowIds);
    db.prepare(`DELETE FROM runtime_turns WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM runtime_sessions WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM quality_reviews WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM context_decisions WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM task_handoffs WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM context_packets WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(
      `DELETE FROM context_messages
        WHERE thread_id IN (SELECT id FROM context_threads WHERE run_id IN (?, ?))`,
    ).run(...workflowIds);
    db.prepare(`DELETE FROM context_threads WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM context_channels WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM workflow_control_state WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM dashboard_workflow_overrides WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM events WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (?, ?)`).run(...workflowIds);

    upsertWorkflowFixture(
      db,
      RUNNING_WORKFLOW_ID,
      'executing',
      'E2E workflow controls running fixture',
      now,
    );
    upsertWorkflowFixture(
      db,
      PAUSED_WORKFLOW_ID,
      'paused',
      'E2E workflow controls paused fixture',
      now,
    );

    for (const workflowId of workflowIds) {
      insertTask(db, {
        id: `${workflowId}_task_01`,
        workflow_id: workflowId,
        name: 'E2E task 01',
        kind: 'cli_spawn',
        input_json: JSON.stringify({ prompt: 'E2E debugger task input' }),
        output_json: workflowId === RUNNING_WORKFLOW_ID ? null : JSON.stringify({ result_text: 'paused fixture' }),
        status: workflowId === RUNNING_WORKFLOW_ID ? 'running' : 'pending',
        depends_on: [],
        executor_hint: 'cli:codex',
        timeout_seconds: 300,
        max_retries: 1,
        retry_count: 0,
        retry_policy: 'exponential',
        started_at: now - 5_000,
        completed_at: null,
        created_at: now - 6_000,
        acceptance_criteria: 'Expose workflow controls and debugger export.',
        refine_count: 0,
        max_refine: 1,
        refine_feedback: null,
        model: 'cx/gpt-5.4',
        hitl: false,
        execution_mode: 'ephemeral',
        tool_name: null,
      });

      insertEvent(db, {
        workflow_id: workflowId,
        task_id: `${workflowId}_task_01`,
        type: 'task_started',
        payload: { source: 'e2e', message: 'task 01 started' },
      });
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: `${workflowId}_task_01`,
        type: 'task_streaming_chunk',
        payload: { stream: 'stdout', chunk: 'E2E terminal line from task 01' },
      });
    }

    db.prepare(
      `INSERT INTO workflow_control_state
         (workflow_id, state, requested_by, reason, created_at, updated_at)
       VALUES (?, 'running', 'e2e', NULL, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         state = excluded.state,
         requested_by = excluded.requested_by,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    ).run(RUNNING_WORKFLOW_ID, now, now);
    db.prepare(
      `INSERT INTO workflow_control_state
         (workflow_id, state, requested_by, reason, created_at, updated_at)
       VALUES (?, 'paused', 'e2e', 'paused fixture', ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         state = excluded.state,
         requested_by = excluded.requested_by,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    ).run(PAUSED_WORKFLOW_ID, now, now);

    saveQualityReview(db, {
      workflowId: RUNNING_WORKFLOW_ID,
      taskId: `${RUNNING_WORKFLOW_ID}_task_01`,
      scope: 'task',
      reviewerKind: 'light_ai',
      reviewerModel: 'deepseek/deepseek-v4-flash',
      outcome: 'needs_fixes',
      score: 0.42,
      issues: [
        {
          severity: 'blocking',
          code: 'e2e_quality_issue',
          origin: 'light_ai',
          message: 'E2E quality issue visible in debugger.',
          suggestedAction: 'Retry the task with a concrete deliverable and rerun the quality gate.',
        },
      ],
      evidence: [
        {
          kind: 'task_output',
          label: 'E2E task output review',
          summary: 'The debugger must expose this quality evidence.',
        },
      ],
      fixTasks: [
        {
          title: 'E2E fix quality issue',
          kind: 'cli_spawn',
          objective: 'Fix the seeded quality issue.',
          acceptanceCriteria: 'The quality tab and export include the generated fix task.',
        },
      ],
      auditStatus: 'recorded',
      runMode: 'dry-run',
      createdAt: now + 1,
    });

    db.prepare(
      `INSERT INTO runtime_sessions
         (id, workflow_id, task_id, executor_id, protocol_tier, stream_format,
          native_session_id, runtime_mode, status, workspace_path, fallback_reason,
          approval_status, audit_status, run_mode, metadata_json, created_at, updated_at, last_used_at)
       VALUES ('rs_e2e_runtime', ?, ?, 'cli:claude-code', 'jsonl-headless', 'claude-stream-json',
          'native_e2e_session', 'persistent', 'active', ?, NULL,
          'approved', 'recorded', 'approved-run', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          task_id = excluded.task_id,
          status = excluded.status,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at,
          last_used_at = excluded.last_used_at`,
    ).run(
      RUNNING_WORKFLOW_ID,
      `${RUNNING_WORKFLOW_ID}_task_01`,
      RUN_TARGET_ROOT,
      JSON.stringify({
        process_state: 'metadata-only',
        profile: 'code',
        last_heartbeat_at: now,
      }),
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO runtime_turns
         (id, session_id, workflow_id, task_id, attempt, status, started_at,
          completed_at, duration_ms, prompt_summary, result_summary, error_json, metadata_json)
       VALUES ('rt_e2e_runtime', 'rs_e2e_runtime', ?, ?, 1, 'completed', ?,
          ?, 20, 'E2E runtime turn', 'done', NULL, '{}')
       ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          completed_at = excluded.completed_at,
          result_summary = excluded.result_summary`,
    ).run(RUNNING_WORKFLOW_ID, `${RUNNING_WORKFLOW_ID}_task_01`, now - 50, now - 30);
    db.prepare(
      `INSERT OR REPLACE INTO runtime_stream_events
         (id, session_id, turn_id, workflow_id, task_id, seq, type, event_json, created_at)
       VALUES (900001, 'rs_e2e_runtime', 'rt_e2e_runtime', ?, ?, 1,
          'assistant.message', ?, ?)`,
    ).run(
      RUNNING_WORKFLOW_ID,
      `${RUNNING_WORKFLOW_ID}_task_01`,
      JSON.stringify({ type: 'assistant.message', text: 'E2E runtime event' }),
      now - 20,
    );

    db.prepare(`DELETE FROM dag_drafts WHERE id = ?`).run(DRAFT_ID);
    db.prepare(
      `INSERT INTO dag_drafts
         (id, workspace, title, objective, dag_json, status, source,
          started_workflow_id, created_at, updated_at)
       VALUES (?, 'internal', 'E2E saved DAG draft', 'E2E saved DAG draft objective', ?, 'draft', 'e2e', NULL, ?, ?)`,
    ).run(
      DRAFT_ID,
      JSON.stringify({
        tasks: [
          {
            id: 'draft_task_01',
            name: 'Draft task 01',
            kind: 'llm_call',
            depends_on: [],
            model: 'cx/gpt-5.4',
            executor_hint: 'cli:codex',
            acceptance_criteria: 'Draft can be reopened without starting a run.',
          },
        ],
      }),
      now,
      now,
    );
  } finally {
    db.close();
  }
}

function cleanupWorkflowControlsFixtures() {
  const db = initDb(getDbPath());
  const workflowIds = [RUNNING_WORKFLOW_ID, PAUSED_WORKFLOW_ID];
  try {
    db.prepare(`DELETE FROM runtime_stream_events WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM runtime_turns WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM runtime_sessions WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM quality_reviews WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM context_decisions WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM task_handoffs WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM context_packets WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(
      `DELETE FROM context_messages
        WHERE thread_id IN (SELECT id FROM context_threads WHERE run_id IN (?, ?))`,
    ).run(...workflowIds);
    db.prepare(`DELETE FROM context_threads WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM context_channels WHERE run_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM workflow_control_state WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM dashboard_workflow_overrides WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM events WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (?, ?)`).run(...workflowIds);
    db.prepare(`DELETE FROM workflows WHERE id IN (?, ?) AND created_by = 'e2e'`).run(...workflowIds);
    db.prepare(`DELETE FROM dag_drafts WHERE id = ? AND source = 'e2e'`).run(DRAFT_ID);
    db.prepare(`DELETE FROM dashboard_workspaces WHERE name = ? AND created_by = 'e2e'`).run(RUN_TARGET_WORKSPACE);
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  seedWorkflowControlsFixtures();
});

test.afterAll(() => {
  cleanupWorkflowControlsFixtures();
});

test('workflow controls expose pause, cancel, debugger export, and dry-run audit', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('clipboard blocked by test');
        },
      },
    });
    const originalExecCommand = document.execCommand.bind(document);
    document.execCommand = (commandId: string, showUI?: boolean, value?: string): boolean => {
      if (commandId === 'copy') {
        const active = document.activeElement as HTMLTextAreaElement | null;
        (window as unknown as { __omniforgeCopiedText?: string }).__omniforgeCopiedText =
          typeof active?.value === 'string' ? active.value : '';
        return true;
      }
      return originalExecCommand(commandId, showUI, value);
    };
  });
  await openDashboard(page, `/dashboard/runs/${RUNNING_WORKFLOW_ID}`);

  await expect(page.getByRole('button', { name: /pause workflow/i })).toBeVisible();
  await page.getByRole('button', { name: /pause workflow/i }).click();
  await expect(page.getByText(/last daemon ack/i)).toContainText(/pause_requested/i);

  await page.getByRole('button', { name: /cancel workflow/i }).click();
  await expect(page.getByText(/last daemon ack/i)).toContainText(/canceled|cancel_requested/i);

  await page.getByRole('button', { name: /open debugger/i }).click();
  await expect(page.getByText(/Workflow Debugger/i)).toBeVisible();
  await expect(page.getByText(/task 01/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /copy current debugger tab/i })).toBeVisible();
  await page.getByRole('button', { name: /copy current debugger tab/i }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __omniforgeCopiedText?: string }).__omniforgeCopiedText ?? '',
      ),
    )
    .toContain(RUNNING_WORKFLOW_ID);
  await page.getByRole('button', { name: /^context$/i }).click();
  await expect(page.getByText(/Recent Context Messages/i)).toBeVisible();
  await expect(page.getByText('Context Packets', { exact: true })).toBeVisible();
  await expect(page.getByText('Task Handoffs', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^quality$/i }).click();
  await expect(page.getByText(/e2e_quality_issue/i)).toBeVisible();
  await expect(page.getByText(/E2E fix quality issue/i)).toBeVisible();
  await page.getByRole('button', { name: /^runtime$/i }).click();
  await expect(page.locator('.text-mono-sm', { hasText: 'native_session: native_e2e_session' }).first()).toBeVisible();
  await expect(page.getByText(/resume can be checked/i)).toBeVisible();
  await page.getByRole('button', { name: /^probes$/i }).click();
  await expect(page.getByText(/Engine Probes/i)).toBeVisible();
  await page.getByRole('button', { name: /run dry-run probe/i }).click();
  await expect(page.getByText(/Latest Probe Result/i)).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/runtime_probe_dry_run/i).first()).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: /^council$/i }).click();
  await expect(page.getByText(/Council Thread/i)).toBeVisible();
  await page.getByRole('button', { name: /ask council/i }).click();
  await expect(page.getByText(/Council dry-run recorded/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/fix task draft/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /^quality$/i }).click();
  await page.getByRole('button', { name: /copy current debugger tab/i }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __omniforgeCopiedText?: string }).__omniforgeCopiedText ?? '',
      ),
    )
    .toContain('e2e_quality_issue');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^Export$/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/omniforge-workflow-debug/);

  await page.getByRole('button', { name: /dry-run audit/i }).click();
  await expect(page.getByText(/audit_status:/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/run_mode: dry-run/i)).toBeVisible();
});

test('paused workflow exposes resume and preserves daemon acknowledgement', async ({ page }) => {
  await openDashboard(page, `/dashboard/runs/${PAUSED_WORKFLOW_ID}`);

  await expect(page.getByRole('button', { name: /resume workflow/i })).toBeVisible();
  await page.getByRole('button', { name: /resume workflow/i }).click();
  await expect(page.getByText(/last daemon ack/i)).toContainText(/resume_requested/i);
});

test('saved DAG draft is visible and can be reopened without starting a run', async ({ page }) => {
  await openDashboard(page, '/dashboard/ask');

  await expect(page.getByText(/SAVED DAG DRAFTS/i)).toBeVisible();
  await expect(page.getByText(/E2E saved DAG draft/i)).toBeVisible();
  await page.getByRole('button', { name: /open draft/i }).first().click();
  await expect(page.getByText(/Approve & Run/i)).toBeVisible();
});

test('ask run creation exposes an explicit workspace and repo target', async ({ page }) => {
  await openDashboard(page, '/dashboard/ask');

  await expect(page.getByText(/Run target/i)).toBeVisible();
  await page.getByRole('button', { name: /choose folder\/repo/i }).click();
  await expect(page.getByText(/Project root/i)).toBeVisible();
  await page.locator('select').selectOption(RUN_TARGET_WORKSPACE);
  await expect(page.getByRole('textbox', { name: /project root/i })).toHaveValue(RUN_TARGET_ROOT);
  await expect(page.getByText(/Plan, Build, Discuss, Save Draft and Approve Run will use this target/i)).toBeVisible();
  await page.getByRole('radio', { name: /Existing code feature/i }).click();
  await expect(page.getByRole('radio', { name: /Existing code feature/i })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/architecture scout and contract tasks/i)).toBeVisible();
  await expect(page.getByText(/Existing-code mode will scout this project root/i)).toBeVisible();
});
