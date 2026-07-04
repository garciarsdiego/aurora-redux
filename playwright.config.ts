import { defineConfig } from '@playwright/test';

const daemonToken = process.env.OMNIFORGE_DAEMON_TOKEN ?? '';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  workers: 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'tests/e2e-result.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:20129',
    headless: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      Authorization: `Bearer ${daemonToken}`,
    },
  },
});
