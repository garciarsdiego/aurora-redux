import { expect, test, type Page } from '@playwright/test';
import { openDashboard, seedE2EFixtures } from './_helpers';

const HYDRATED_SELECTOR = '#root';

// Wave 3 (M1-W3-C): seed canonical fixtures so the run list has rows.
test.beforeAll(async () => {
  await seedE2EFixtures();
});

async function openRunList(page: Page) {
  await openDashboard(page, '/dashboard/runs');
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
}

test('renders the Runs screen heading and copy', async ({ page }) => {
  await openRunList(page);
  await expect(page.locator('text=/RUN LIST/i').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Runs/i })).toBeVisible();
  await expect(page.locator("text=/Every workflow you've planned, queued, executed, or aborted\./i").first()).toBeVisible();
});

test('renders run filter controls', async ({ page }) => {
  await openRunList(page);
  await expect(page.getByRole('button', { name: /^all\s+\d+/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^active\s+\d+/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /^failed\s+\d+/i })).toBeVisible();
});

test('shows run row actions or the empty state', async ({ page }) => {
  await openRunList(page);
  const firstRun = page.getByRole('button', { name: /^Open run /i }).first();
  const emptyState = page.locator('text=/Nothing here yet\\\./i').first();
  const actions = page.getByRole('button', { name: /Run actions/i });
  await expect(firstRun.or(emptyState)).toBeVisible();
  if (await firstRun.isVisible()) {
    await expect(firstRun).toBeVisible();
    await expect(actions.first()).toBeVisible();
  } else {
    await expect(emptyState).toBeVisible();
  }
});
