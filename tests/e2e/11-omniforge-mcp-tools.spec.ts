import { expect, test, type APIRequestContext } from '@playwright/test';
import { getToken } from './_helpers';

const requiredTools = [
  'omniforge_run_workflow',
  'omniforge_get_workflow_status',
  'omniforge_approve_gate',
  'omniforge_vault_read',
  'omniforge_vault_write',
  'omniforge_builder_chat',
  'omniforge_replay_persona_version',
  'omniforge_run_meta_workflow',
  'omniforge_listmodels',
];

async function fetchToolNames(request: APIRequestContext) {
  const response = await request.get('/mcp/tools/list', {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  return body.tools.map((tool: { name: string }) => tool.name);
}

test('MCP tool list includes required workflow and gate tools', async ({ request }) => {
  const names = await fetchToolNames(request);
  expect(names).toEqual(expect.arrayContaining([
    'omniforge_run_workflow',
    'omniforge_get_workflow_status',
    'omniforge_approve_gate',
  ]));
});

test('MCP tool list includes required vault builder and replay tools', async ({ request }) => {
  const names = await fetchToolNames(request);
  expect(names).toEqual(expect.arrayContaining([
    'omniforge_vault_read',
    'omniforge_vault_write',
    'omniforge_builder_chat',
    'omniforge_replay_persona_version',
    'omniforge_run_meta_workflow',
  ]));
});

test('MCP tool list includes every Wave 3 required tool name', async ({ request }) => {
  const names = await fetchToolNames(request);
  for (const tool of requiredTools) {
    expect(names, tool).toContain(tool);
  }
});
