import { expect, test, type APIRequestContext } from '@playwright/test';
import { getToken } from './_helpers';

const requiredPrefixes = ['kmc/','minimax/','glm/','cu/','cx/','gemini-cli/','opencode-go/'];
const discouragedPrefixes = ['cc/', 'gh/', 'nvidia/'];

async function fetchModels(request: APIRequestContext) {
  const response = await request.get('/api/dashboard/model-catalog', {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toHaveProperty('models');
  return (body.models as Array<{ model_id?: string; id?: string }>).map((m) => m.model_id ?? m.id ?? '').filter(Boolean);
}

test('model catalog returns at least 50 models', async ({ request }) => {
  const ids = await fetchModels(request);
  expect(ids.length).toBeGreaterThanOrEqual(50);
});

test('model catalog includes all required provider prefixes', async ({ request }) => {
  const ids = await fetchModels(request);
  for (const prefix of requiredPrefixes) {
    expect(ids.some((id) => id.startsWith(prefix)), prefix).toBe(true);
  }
});

test('model catalog flags presence of discouraged providers (informational)', async ({ request }) => {
  const ids = await fetchModels(request);
  // Discouraged prefixes may be PRESENT in the catalog (their data is loaded)
  // but the runtime should not USE them. This test is informational — it just
  // documents which discouraged prefixes are visible to the catalog.
  const present = discouragedPrefixes.filter((p) => ids.some((id) => id.startsWith(p)));
  // No assertion on count — record observation.
  console.log(`Discouraged prefixes visible in catalog: ${present.join(', ') || '(none)'}`);
  // Sanity: required prefixes still come through
  expect(ids.length).toBeGreaterThan(0);
});
