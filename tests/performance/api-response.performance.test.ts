import { describe, it, expect } from 'vitest';

// TODO Phase 1 (Week 2): re-enable via beforeAll daemon bootstrap.
// These tests require a live daemon at http://127.0.0.1:20129 — see PHASE-0.md §0.4.
describe.skip('Performance: API Response Times (requires live daemon — bootstrap in Week 2)', () => {
  const baseUrl = process.env.OMNIFORGE_E2E_BASE_URL || 'http://127.0.0.1:20129';
  
  // Helper to get auth token
  function getAuthToken(): string {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    
    const tokenFromEnv = process.env.OMNIFORGE_DAEMON_TOKEN?.trim();
    if (tokenFromEnv) {
      return tokenFromEnv;
    }
    
    return readFileSync(resolve(process.cwd(), 'data', 'daemon-token.txt'), 'utf8').trim();
  }

  const authHeaders = {
    Authorization: `Bearer ${getAuthToken()}`,
  };

  it('health endpoint responds in under 100ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/health`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(100);
  });

  it('MCP tools list responds in under 200ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/mcp/tools/list`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(200);
  });

  it('dashboard summary responds in under 300ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/api/dashboard/summary?workspace=internal`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(300);
  });

  it('workflow list responds in under 500ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=50`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(500);
  });

  it('model catalog responds in under 500ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/api/dashboard/model-catalog`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(500);
  });

  it('handles 10 concurrent requests efficiently', async () => {
    const startTime = performance.now();
    
    const requests = [];
    for (let i = 0; i < 10; i++) {
      requests.push(
        fetch(`${baseUrl}/health`, {
          headers: authHeaders,
        })
      );
    }
    
    const responses = await Promise.all(requests);
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(responses.every(r => r.ok)).toBe(true);
    expect(duration).toBeLessThan(500); // 10 requests in under 500ms
  });

  it('SSE endpoint establishes connection quickly', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/api/dashboard/sse?workspace=internal`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(200);
    
    // Close the SSE connection
    response.body?.cancel();
  });

  it('pattern list responds in under 300ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/api/dashboard/patterns?workspace=internal`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(300);
  });

  it('vault files list responds in under 300ms', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/api/dashboard/vault/files?workspace=internal`, {
      headers: authHeaders,
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(300);
  });

  it('MCP tool call responds in under 1 second for simple operations', async () => {
    const startTime = performance.now();
    
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'omniforge_list_patterns',
        arguments: {
          workspace: 'internal',
        },
      }),
    });
    
    const endTime = performance.now();
    const duration = endTime - startTime;
    
    expect(response.ok).toBe(true);
    expect(duration).toBeLessThan(1000);
  });
});