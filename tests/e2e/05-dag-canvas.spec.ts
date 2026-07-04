import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  E2E_SEEDED_WORKFLOW_EXECUTING,
  E2E_WORKSPACE,
  getToken,
  openDashboard,
  seedE2EFixtures,
} from './_helpers';

// Wave 3 (M1-W3-C): seed canonical fixtures so we no longer silently skip
// on fresh checkouts. `firstWorkflowId` prefers the seeded executing
// workflow, but still falls back to the summary endpoint to remain
// compatible with environments where the seed could not be applied.
test.beforeAll(async () => {
  await seedE2EFixtures();
});

async function firstWorkflowId(request: APIRequestContext): Promise<string | null> {
  const response = await request.get(`/api/dashboard/summary?workspace=${encodeURIComponent(E2E_WORKSPACE)}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  expect(response.status()).toBe(200);
  const summary = await response.json();
  const workflows = Array.isArray(summary?.workflows) ? summary.workflows : [];
  // Prefer the seeded executing workflow when present.
  const seeded = workflows.find((run: unknown) => {
    const row = run as { id?: unknown; workflow_id?: unknown };
    return row.id === E2E_SEEDED_WORKFLOW_EXECUTING || row.workflow_id === E2E_SEEDED_WORKFLOW_EXECUTING;
  }) as { id?: string; workflow_id?: string } | undefined;
  if (seeded) return seeded.id ?? seeded.workflow_id ?? E2E_SEEDED_WORKFLOW_EXECUTING;

  const first = workflows.find((run: unknown) => {
    const row = run as { id?: unknown; workflow_id?: unknown };
    return typeof row.id === 'string' || typeof row.workflow_id === 'string';
  }) as { id?: string; workflow_id?: string } | undefined;
  return first?.id ?? first?.workflow_id ?? E2E_SEEDED_WORKFLOW_EXECUTING;
}

async function openDagCanvas(page: Page, request: APIRequestContext) {
  const workflowId = await firstWorkflowId(request);
  // Seed guarantees a workflow exists; fall back to seeded id if summary
  // can't locate it (e.g. dashboard summary cache lag).
  const targetId = workflowId ?? E2E_SEEDED_WORKFLOW_EXECUTING;
  await openDashboard(page, `/dashboard/runs/${targetId}`);
  // Wait until the DagCanvas is hydrated (Refresh snapshot button is visible)
  // OR the RunNotFound fallback renders. Either path proves the SPA finished
  // its first /api/dashboard/summary fetch — using #root alone is too cheap
  // because the React root is attached from index.html load.
  await Promise.race([
    page.getByLabel(/Refresh snapshot/i).first().waitFor({ state: 'visible', timeout: 15000 }),
    page.getByText(/Run not found/i).first().waitFor({ state: 'visible', timeout: 15000 }),
  ]);
}

test('renders DagCanvas header actions for an available workflow', async ({ page, request }) => {
  await openDagCanvas(page, request);
  await expect(page.getByLabel(/Refresh snapshot/i).first()).toBeVisible();
  await expect(page.getByLabel(/Open folder/i).first()).toBeVisible();
});

test('renders DagCanvas graph region or empty task state', async ({ page, request }) => {
  await openDagCanvas(page, request);
  const miniMap = page.getByRole('img', { name: /DAG mini-map/i }).first();
  const emptyState = page.locator('text=/No tasks yet/i').first();
  await expect(miniMap.or(emptyState)).toBeVisible();
  if (await miniMap.isVisible()) {
    await expect(miniMap.first()).toBeVisible();
  } else {
    await expect(emptyState).toBeVisible();
  }
});

test('renders DagCanvas instruction composer', async ({ page, request }) => {
  await openDagCanvas(page, request);
  await expect(page.getByPlaceholder(/Ask the workflow to adjust something/i)).toBeVisible();
});
