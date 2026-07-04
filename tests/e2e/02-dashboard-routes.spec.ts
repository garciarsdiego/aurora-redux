import { expect, test, type Page } from '@playwright/test';
import { openDashboard } from './_helpers';

const HYDRATED_SELECTOR = '#root';

async function openDashboardShell(page: Page, path: string) {
  const response = await openDashboard(page, path);
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
  expect(response, path).not.toBeNull();
  expect(response!.status(), path).toBe(200);
  expect(await response!.text(), path).toContain('<div id="root"');
}

test('serves primary dashboard routes as the SPA shell', async ({ page }) => {
  for (const route of ['/dashboard', '/dashboard/', '/dashboard/runs']) {
    await openDashboardShell(page, route);
  }
});

test('serves management dashboard routes as the SPA shell', async ({ page }) => {
  for (const route of ['/dashboard/patterns', '/dashboard/setup', '/dashboard/onboarding']) {
    await openDashboardShell(page, route);
  }
});

test('serves builder vault and advisor routes as the SPA shell', async ({ page }) => {
  for (const route of ['/dashboard/builder', '/dashboard/vault', '/dashboard/advisors/chat']) {
    await openDashboardShell(page, route);
  }
});
