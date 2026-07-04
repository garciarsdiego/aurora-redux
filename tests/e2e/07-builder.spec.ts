import { expect, test, type Page } from '@playwright/test';
import { openDashboard } from './_helpers';

const HYDRATED_SELECTOR = '#root';

async function openBuilder(page: Page) {
  await openDashboard(page, '/dashboard/builder');
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
}

test('renders BuilderChatPanel heading', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByRole('heading', { name: /AI Builder/i })).toBeVisible();
  await expect(page.locator('text=/Mission Control/i').first()).toBeVisible();
});

test('renders builder chat controls', async ({ page }) => {
  await openBuilder(page);
  await expect(page.getByLabel(/Message planner/i).first()).toBeVisible();
  await expect(page.getByLabel(/Copy session id/i).first()).toBeVisible();
});

test('renders DAG preview area', async ({ page }) => {
  await openBuilder(page);
  await expect(page.locator('text=/DAG preview/i').first()).toBeVisible();
  await expect(page.locator('text=/The builder graph appears here once the persona proposes tasks/i').first()).toBeVisible();
});
