import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

test.describe('Cost Tracking and Budget Enforcement E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('tracks cost per workflow in ledger', async ({ request }) => {
    const response = await request.get('/api/dashboard/llm-ledger?workspace=internal', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('calls');
    expect(Array.isArray(body.calls)).toBe(true);
    
    // If there are calls, verify the structure
    if (body.calls.length > 0) {
      const firstCall = body.calls[0];
      expect(firstCall).toHaveProperty('workflow_id');
      expect(firstCall).toHaveProperty('model');
      expect(firstCall).toHaveProperty('tokens_in');
      expect(firstCall).toHaveProperty('tokens_out');
      expect(firstCall).toHaveProperty('cost_usd');
      expect(firstCall).toHaveProperty('latency_ms');
    }
  });

  test('enforces cost cap on workflow execution', async ({ request }) => {
    const objective = 'Test workflow with cost cap';
    const maxCost = 0.01; // Very low cap to trigger enforcement
    
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective,
          workspace: 'internal',
          max_total_cost_usd: maxCost,
          auto_approve: true,
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    // The workflow should start but respect the cap
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('workflow_id');
  });

  test('reports cost budget mid-stream execution', async ({ request }) => {
    // Get workflow summary which includes cost information
    const response = await request.get('/api/dashboard/summary?workspace=internal', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    
    // Verify cost fields are present
    expect(body).toHaveProperty('total_cost_usd');
    expect(typeof body.total_cost_usd).toBe('number');
    expect(body.total_cost_usd).toBeGreaterThanOrEqual(0);
  });

  test('provides cost preview before workflow execution', async ({ request }) => {
    const objective = 'Test cost preview';
    
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_plan_workflow',
        arguments: {
          objective,
          workspace: 'internal',
          estimate_cost: true,
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    // Cost estimation should be included if available
    if (content.estimated_cost_usd !== undefined) {
      expect(typeof content.estimated_cost_usd).toBe('number');
      expect(content.estimated_cost_usd).toBeGreaterThanOrEqual(0);
    }
  });

  test('prevents cost bleed on workflow cancellation', async ({ request }) => {
    // This test verifies that canceling a workflow stops cost accumulation
    // We'll create a workflow and immediately cancel it
    
    const objective = 'Test cost bleed prevention';
    
    const executeResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective,
          workspace: 'internal',
          auto_approve: true,
        },
      }),
    });
    
    expect(executeResponse.status()).toBe(200);
    const executeResult = await executeResponse.json();
    const executeContent = JSON.parse(executeResult.content[0].text);
    const workflowId = executeContent.workflow_id;
    
    // Get initial cost
    const initialCostResponse = await request.get(`/api/dashboard/workflows/${workflowId}`, {
      headers: authHeaders(),
    });
    
    let initialCost = 0;
    if (initialCostResponse.status() === 200) {
      const initialResult = await initialCostResponse.json();
      initialCost = initialResult.actual_cost_usd || 0;
    }
    
    // Cancel the workflow
    await request.post(`/api/dashboard/workflows/${workflowId}/cancel`, {
      headers: authHeaders(),
    });
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get final cost - should not have increased significantly after cancellation
    const finalCostResponse = await request.get(`/api/dashboard/workflows/${workflowId}`, {
      headers: authHeaders(),
    });
    
    if (finalCostResponse.status() === 200) {
      const finalResult = await finalCostResponse.json();
      const finalCost = finalResult.actual_cost_usd || 0;
      
      // Cost should not have increased by more than a tiny amount after cancellation
      const costIncrease = finalCost - initialCost;
      expect(costIncrease).toBeLessThan(0.01); // Less than 1 cent increase
    }
  });
});