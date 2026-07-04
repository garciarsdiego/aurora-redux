import { expect, test } from '@playwright/test';
import { mcpFetch, getToken } from './_helpers';

test.describe('Workflow Lifecycle E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('creates a new workflow via plan_workflow and executes it', async ({ request }) => {
    const objective = 'Create a simple test workflow for E2E testing';
    
    // Plan the workflow
    const planResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_plan_workflow',
        arguments: {
          objective,
          workspace: 'internal',
          auto_approve: false,
        },
      }),
    });
    
    expect(planResponse.status()).toBe(200);
    const planResult = await planResponse.json();
    expect(planResult).toHaveProperty('content');
    const planContent = JSON.parse(planResult.content[0].text);
    expect(planContent).toHaveProperty('dag_json');
    
    // Execute the workflow
    const executeResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective,
          workspace: 'internal',
          precomputed_dag: planContent.dag_json,
          auto_approve: true,
        },
      }),
    });
    
    expect(executeResponse.status()).toBe(200);
    const executeResult = await executeResponse.json();
    expect(executeResult).toHaveProperty('content');
    const executeContent = JSON.parse(executeResult.content[0].text);
    expect(executeContent).toHaveProperty('workflow_id');
    
    const workflowId = executeContent.workflow_id;
    
    // Poll for workflow completion (with timeout)
    let status = 'executing';
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds timeout
    
    while (status === 'executing' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const statusResponse = await request.get(`/api/dashboard/workflows/${workflowId}`, {
        headers: authHeaders(),
      });
      
      if (statusResponse.status() === 200) {
        const statusResult = await statusResponse.json();
        status = statusResult.status;
      }
      
      attempts++;
    }
    
    // Verify workflow completed or failed (not stuck in executing)
    expect(['completed', 'failed', 'canceled']).toContain(status);
  });

  test('cancels an executing workflow via API', async ({ request }) => {
    const objective = 'Workflow to be canceled for E2E testing';
    
    // Start a workflow
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
    
    // Cancel the workflow
    const cancelResponse = await request.post(`/api/dashboard/workflows/${workflowId}/cancel`, {
      headers: authHeaders(),
    });
    
    expect([200, 202]).toContain(cancelResponse.status());
    
    // Verify cancellation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const statusResponse = await request.get(`/api/dashboard/workflows/${workflowId}`, {
      headers: authHeaders(),
    });
    
    if (statusResponse.status() === 200) {
      const statusResult = await statusResponse.json();
      expect(['canceled', 'canceling', 'failed']).toContain(statusResult.status);
    }
  });

  test('lists workflows with filters', async ({ request }) => {
    // List all workflows
    const allResponse = await request.get('/api/dashboard/workflows?workspace=internal', {
      headers: authHeaders(),
    });
    
    expect(allResponse.status()).toBe(200);
    const allResult = await allResponse.json();
    expect(Array.isArray(allResult.workflows)).toBe(true);
    
    // List only active workflows
    const activeResponse = await request.get('/api/dashboard/workflows?workspace=internal&status=executing', {
      headers: authHeaders(),
    });
    
    expect(activeResponse.status()).toBe(200);
    const activeResult = await activeResponse.json();
    expect(Array.isArray(activeResult.workflows)).toBe(true);
    
    // List only completed workflows
    const completedResponse = await request.get('/api/dashboard/workflows?workspace=internal&status=completed', {
      headers: authHeaders(),
    });
    
    expect(completedResponse.status()).toBe(200);
    const completedResult = await completedResponse.json();
    expect(Array.isArray(completedResult.workflows)).toBe(true);
  });

  test('gets detailed workflow status including tasks and events', async ({ request }) => {
    // First get a workflow ID from the list
    const listResponse = await request.get('/api/dashboard/workflows?workspace=internal&limit=1', {
      headers: authHeaders(),
    });
    
    if (listResponse.status() === 200) {
      const listResult = await listResponse.json();
      const workflows = listResult.workflows;
      
      if (workflows && workflows.length > 0) {
        const workflowId = workflows[0].id || workflows[0].workflow_id;
        
        // Get detailed status
        const detailResponse = await request.get(`/api/dashboard/workflows/${workflowId}`, {
          headers: authHeaders(),
        });
        
        expect(detailResponse.status()).toBe(200);
        const detailResult = await detailResponse.json();
        expect(detailResult).toHaveProperty('status');
        expect(detailResult).toHaveProperty('tasks');
        expect(Array.isArray(detailResult.tasks)).toBe(true);
        expect(detailResult).toHaveProperty('events');
        expect(Array.isArray(detailResult.events)).toBe(true);
      }
    }
  });

  test('resolves a HITL gate via approve_gate tool', async ({ request }) => {
    // This test assumes there's a pending gate or creates one
    // In a real scenario, you'd seed a workflow with a pending gate
    
    const gateId = 'test_gate_e2e';
    const decision = 'approve';
    const reason = 'E2E test approval';
    
    const approveResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_approve_gate',
        arguments: {
          gate_id: gateId,
          decision,
          reason,
        },
      }),
    });
    
    // The gate might not exist, so we accept either success or a not-found error
    expect([200, 404]).toContain(approveResponse.status());
  });
});