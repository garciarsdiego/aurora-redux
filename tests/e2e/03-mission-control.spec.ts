import { expect, test, type Page } from '@playwright/test';
import { openDashboard, seedE2EFixtures } from './_helpers';

const HYDRATED_SELECTOR = '#root';

// Wave 3 (M1-W3-C): seed canonical fixtures so Mission Control KPIs are
// non-zero (Active runs, Pending approvals).
test.beforeAll(async () => {
  await seedE2EFixtures();
});

async function openMissionControl(page: Page) {
  await openDashboard(page, '/dashboard/');
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
}

test('renders the Mission Control overview heading', async ({ page }) => {
  await openMissionControl(page);
  await expect(page.locator('text=/MISSION CONTROL/i').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Overview of your operations\./i })).toBeVisible();
});

test('renders Mission Control operational sections', async ({ page }) => {
  await openMissionControl(page);
  await expect(page.getByRole('heading', { name: /Active now/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Pending approvals/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Recent activity/i })).toBeVisible();
});

test('renders Mission Control KPI labels and primary action', async ({ page }) => {
  await openMissionControl(page);
  await expect(page.locator('text=/Active runs/i').first()).toBeVisible();
  await expect(page.locator("text=/Today's cost/i").first()).toBeVisible();
  await expect(page.getByLabel(/Plan a new run/i).first()).toBeVisible();
});
