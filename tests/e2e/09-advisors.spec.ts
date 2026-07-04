import { expect, test, type Page } from '@playwright/test';
import { openDashboard } from './_helpers';

const HYDRATED_SELECTOR = '#root';

async function openAdvisor(page: Page, advisor: string) {
  await openDashboard(page, `/dashboard/advisors/${advisor}`);
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
}

test('renders chat advisor screen', async ({ page }) => {
  await openAdvisor(page, 'chat');
  await expect(page.locator('text=/ADVISOR/i').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Chat/i })).toBeVisible();
  // Wave 1 redesign: screens pass a `description` prop so the omniforge_chat
  // code element is no longer rendered. Check the prompt input instead.
  await expect(page.locator('[data-testid="advisor-prompt-input"]')).toBeVisible();
});

test('renders code review advisor screen', async ({ page }) => {
  await openAdvisor(page, 'codereview');
  await expect(page.getByRole('heading', { name: /Code review/i })).toBeVisible();
  await expect(page.getByLabel(/Per-call mode override for codereview/i).first()).toBeVisible();
  // Wave 1 redesign: description prop replaced the omniforge_codereview code block.
  await expect(page.locator('[data-testid="advisor-prompt-input"]')).toBeVisible();
});

test('renders debug advisor screen', async ({ page }) => {
  await openAdvisor(page, 'debug');
  await expect(page.getByRole('heading', { name: /Debug/i })).toBeVisible();
  await expect(page.getByLabel(/Mode help/i).first()).toBeVisible();
  // Wave 1 redesign: description prop replaced the omniforge_debug code block.
  await expect(page.locator('[data-testid="advisor-prompt-input"]')).toBeVisible();
});
