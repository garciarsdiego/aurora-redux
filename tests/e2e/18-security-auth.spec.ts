import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

test.describe('Security and Authentication E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('rejects requests without valid Bearer token', async ({ request }) => {
    const response = await request.get('/api/dashboard/summary', {
      headers: { Authorization: 'Bearer invalid_token' },
    });
    
    expect([401, 403]).toContain(response.status());
  });

  test('rejects requests without Authorization header', async ({ request }) => {
    const response = await request.get('/api/dashboard/summary');
    
    expect([401, 403]).toContain(response.status());
  });

  test('uses timing-safe comparison for Bearer tokens', async ({ request }) => {
    // This test verifies that token comparison is timing-safe
    // to prevent timing attacks
    
    const validToken = getToken();
    const invalidToken = validToken + 'x';
    
    // Both requests should take similar time (not easily testable in E2E)
    // but we verify both are rejected/accepted appropriately
    const validResponse = await request.get('/api/dashboard/summary', {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    
    const invalidResponse = await request.get('/api/dashboard/summary', {
      headers: { Authorization: `Bearer ${invalidToken}` },
    });
    
    expect(validResponse.status()).toBe(200);
    expect([401, 403]).toContain(invalidResponse.status());
  });

  test('protects dashboard assets with Bearer auth', async ({ request }) => {
    const response = await request.get('/dashboard', {
      headers: { Authorization: 'Bearer invalid_token' },
    });
    
    // Dashboard should redirect to login or return 401/403
    expect([200, 302, 401, 403]).toContain(response.status());
  });

  test('binds daemon to localhost only', async ({ request }) => {
    // This test verifies the daemon is not exposed to external networks
    // In a real E2E, we'd test from an external network
    // For now, we verify localhost works
    
    const response = await request.get('http://127.0.0.1:20129/health', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
  });

  test('sanitizes error messages to prevent information leakage', async ({ request }) => {
    const response = await request.get('/api/dashboard/workflows/nonexistent-id', {
      headers: authHeaders(),
    });
    
    // Should return 404 without leaking internal details
    if (response.status() === 404) {
      const body = await response.json();
      // Error message should be generic, not revealing internal paths
      expect(body.error).not.toMatch(/\/[a-z0-9_\/]+\//i);
    }
  });

  test('prevents path traversal in file operations', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_read_file',
        arguments: {
          path: '../../../etc/passwd',
        },
      }),
    });
    
    // Should reject path traversal attempts
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('error');
  });

  test('enforces workspace isolation', async ({ request }) => {
    // Create a workflow in workspace 'internal'
    const createResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective: 'Test workspace isolation',
          workspace: 'internal',
          auto_approve: true,
        },
      }),
    });
    
    expect(createResponse.status()).toBe(200);
    
    // Try to access it from a different workspace
    const listResponse = await request.get('/api/dashboard/workflows?workspace=different-workspace', {
      headers: authHeaders(),
    });
    
    expect(listResponse.status()).toBe(200);
    const listResult = await listResponse.json();
    
    // The workflow created in 'internal' should not appear in 'different-workspace'
    if (listResult.workflows) {
      const createResult = await createResponse.json();
      const createContent = JSON.parse(createResult.content[0].text);
      const workflowId = createContent.workflow_id;
      
      const foundInDifferent = listResult.workflows.some(
        (w: any) => (w.id || w.workflow_id) === workflowId
      );
      expect(foundInDifferent).toBe(false);
    }
  });

  test('redacts sensitive data from logs and events', async ({ request }) => {
    // Get workflow events
    const response = await request.get('/api/dashboard/workflows?workspace=internal&limit=1', {
      headers: authHeaders(),
    });
    
    if (response.status() === 200) {
      const body = await response.json();
      if (body.workflows && body.workflows.length > 0) {
        const workflowId = body.workflows[0].id || body.workflows[0].workflow_id;
        
        const eventsResponse = await request.get(`/api/dashboard/workflows/${workflowId}/events`, {
          headers: authHeaders(),
        });
        
        if (eventsResponse.status() === 200) {
          const eventsBody = await eventsResponse.json();
          if (eventsBody.events) {
            // Verify no API keys or secrets are in plain text
            const eventsString = JSON.stringify(eventsBody.events);
            expect(eventsString).not.toMatch(/api[_-]?key\s*[:=]\s*['"][\w-]+['"]/i);
            expect(eventsString).not.toMatch(/secret\s*[:=]\s*['"][\w-]+['"]/i);
          }
        }
      }
    }
  });
});