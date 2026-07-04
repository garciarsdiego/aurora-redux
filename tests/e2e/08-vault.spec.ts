import { expect, test, type Page } from '@playwright/test';
import { openDashboard } from './_helpers';

const HYDRATED_SELECTOR = '#root';
const NO_WORKSPACES_TEXT = 'No workspaces configured. Add one under Setup to use the vault.';

async function openVault(page: Page) {
  await openDashboard(page, '/dashboard/vault');
  await page.waitForSelector(HYDRATED_SELECTOR, { state: 'attached', timeout: 10000 });
}

async function hasNoWorkspaces(page: Page): Promise<boolean> {
  return page.locator(`text=${NO_WORKSPACES_TEXT}`).isVisible();
}

test('renders VaultEditor heading or no-workspaces state', async ({ page }) => {
  await openVault(page);
  if (await hasNoWorkspaces(page)) {
    await expect(page.locator(`text=${NO_WORKSPACES_TEXT}`).first()).toBeVisible();
  } else {
    await expect(page.locator('text=/DATA/i').first()).toBeVisible();
    // VaultBrowser renders two headings matching /Vault/i (page h1 + chrome h2);
    // .first() avoids Playwright strict-mode violation.
    await expect(page.getByRole('heading', { name: /Vault/i }).first()).toBeVisible();
  }
});

test('renders vault workspace controls when workspaces exist', async ({ page }) => {
  await openVault(page);
  if (await hasNoWorkspaces(page)) {
    await expect(page.locator(`text=${NO_WORKSPACES_TEXT}`).first()).toBeVisible();
  } else {
    await expect(page.locator('text=/Workspace/i').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /New/i })).toBeVisible();
  }
});

test('renders vault path and content inputs when workspaces exist', async ({ page }) => {
  await openVault(page);
  if (await hasNoWorkspaces(page)) {
    await expect(page.locator(`text=${NO_WORKSPACES_TEXT}`).first()).toBeVisible();
  } else {
    await expect(page.getByPlaceholder(/Filter paths \(contains\)/)).toBeVisible();
    await expect(page.getByPlaceholder('e.g. *.md or notes/**')).toBeVisible();
    await expect(page.getByPlaceholder('notes/example.md')).toBeVisible();
  }
});
