import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

test.describe('Model Routing and Selection E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('lists available models from catalog', async ({ request }) => {
    const response = await request.get('/api/dashboard/model-catalog', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('models');
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

  test('filters models by provider', async ({ request }) => {
    const response = await request.get('/api/dashboard/model-catalog?provider=cx', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('models');
    expect(Array.isArray(body.models)).toBe(true);
    
    // Verify all returned models are from the requested provider
    for (const model of body.models) {
      const modelId = model.model_id || model.id;
      expect(modelId).toMatch(/^cx\//);
    }
  });

  test('filters models by tier', async ({ request }) => {
    const response = await request.get('/api/dashboard/model-catalog?tier=premium', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('models');
    expect(Array.isArray(body.models)).toBe(true);
  });

  test('routes model based on use case', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_route_model',
        arguments: {
          use_case: 'code_generation',
          strategy: 'balanced',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('model');
    expect(content).toHaveProperty('reasoning');
  });

  test('selects model with quality strategy', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_route_model',
        arguments: {
          use_case: 'code_generation',
          strategy: 'quality',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    const content = JSON.parse(result.content[0].text);
    
    expect(content).toHaveProperty('model');
    expect(content).toHaveProperty('strategy');
    expect(content.strategy).toBe('quality');
  });

  test('selects model with cost strategy', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_route_model',
        arguments: {
          use_case: 'code_generation',
          strategy: 'cost',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    const content = JSON.parse(result.content[0].text);
    
    expect(content).toHaveProperty('model');
    expect(content).toHaveProperty('strategy');
    expect(content.strategy).toBe('cost');
  });

  test('sets hermes model configuration', async ({ request }) => {
    const model = 'cx/gpt-5.4';
    
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_set_hermes_model',
        arguments: {
          model,
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('success');
    expect(content.success).toBe(true);
  });

  test('overrides runtime model configuration', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_set_config',
        arguments: {
          key: 'TASK_MODEL',
          value: 'cx/gpt-5.4',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('success');
  });

  test('filters models by capability', async ({ request }) => {
    const response = await request.get('/api/dashboard/model-catalog?capability=code', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('models');
    expect(Array.isArray(body.models)).toBe(true);
  });
});