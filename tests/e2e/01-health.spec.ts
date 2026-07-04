import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

test('GET /health returns ok status with version and uptime', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(body.version).toEqual(expect.any(String));
  expect(body.uptime_ms).toEqual(expect.any(Number));
});

test('GET /mcp/tools/list returns at least 30 tools', async ({ request }) => {
  const response = await request.get('/mcp/tools/list', { headers: authHeaders() });
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(Array.isArray(body.tools)).toBe(true);
  expect(body.tools.length).toBeGreaterThanOrEqual(30);
});

test('GET /mcp/tools/list response has MCP tool definition shape', async ({ request }) => {
  const response = await request.get('/mcp/tools/list', { headers: authHeaders() });
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  const first = body.tools[0];
  expect(first).toEqual(expect.objectContaining({
    name: expect.any(String),
    description: expect.any(String),
    inputSchema: expect.objectContaining({ type: 'object' }),
  }));
});
