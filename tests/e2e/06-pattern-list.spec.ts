import { expect, test, type Page } from '@playwright/test';
import { openDashboard, seedE2EFixtures } from './_helpers';

const HYDRATED_SELECTOR = '#root';

// Wave 3 (M1-W3-C): seed canonical fixtures so pattern list has rows.
test.beforeAll(async () => {
  await seedE2EFixtures();
});

async function openPatternList(page: Page) {
  await openDashboard(page, '/dashboard/patterns');
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
}

test('renders PatternList heading', async ({ page }) => {
  await openPatternList(page);
  await expect(page.locator('text=/PATTERNS/i').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Saved patterns/i })).toBeVisible();
});

test('renders PatternList descriptive copy', async ({ page }) => {
  await openPatternList(page);
  await expect(page.locator('text=/Reusable DAGs distilled from past runs\\\./i').first()).toBeVisible();
});

test('opens a pattern detail page when a pattern link exists', async ({ page }) => {
  await openPatternList(page);
  const firstPattern = page.locator('a[href^="/dashboard/patterns/"], a[href^="/patterns/"]').first();
  if (await firstPattern.count()) {
    await firstPattern.click();
    await expect(page).toHaveURL(/\/dashboard\/patterns\/[^/]+/);
  } else {
    await expect(page.getByRole('heading', { name: /Saved patterns/i })).toBeVisible();
  }
});
