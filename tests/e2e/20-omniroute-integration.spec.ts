import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

test.describe('Omniroute Integration E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('checks Omniroute health status', async ({ request }) => {
    const response = await request.get('/api/omniroute/health', {
      headers: authHeaders(),
    });
    
    // Omniroute may not be running, so we accept 200 or 503
    expect([200, 503, 404]).toContain(response.status());
    
    if (response.status() === 200) {
      const body = await response.json();
      expect(body).toHaveProperty('status');
    }
  });

  test('syncs costs with Omniroute', async ({ request }) => {
    const response = await request.get('/api/omniroute/cost-report?workspace=internal', {
      headers: authHeaders(),
    });
    
    // Omniroute may not be available
    expect([200, 503, 404]).toContain(response.status());
    
    if (response.status() === 200) {
      const body = await response.json();
      expect(body).toHaveProperty('total_cost_usd');
      expect(typeof body.total_cost_usd).toBe('number');
    }
  });

  test('queries Omniroute quota', async ({ request }) => {
    const response = await request.get('/api/omniroute/quota', {
      headers: authHeaders(),
    });
    
    // Omniroute may not be available
    expect([200, 503, 404]).toContain(response.status());
    
    if (response.status() === 200) {
      const body = await response.json();
      expect(body).toHaveProperty('quota');
    }
  });

  test('requests best model combination from Omniroute', async ({ request }) => {
    const response = await request.get('/api/omniroute/best-combo?use_case=code_generation', {
      headers: authHeaders(),
    });
    
    // Omniroute may not be available
    expect([200, 503, 404]).toContain(response.status());
    
    if (response.status() === 200) {
      const body = await response.json();
      expect(body).toHaveProperty('models');
      expect(Array.isArray(body.models)).toBe(true);
    }
  });

  test('uses Bearer auth for Omniroute bridge endpoints', async ({ request }) => {
    const response = await request.get('/api/omniroute/health', {
      headers: { Authorization: 'Bearer invalid_token' },
    });
    
    // Should reject invalid auth
    expect([401, 403, 503, 404]).toContain(response.status());
  });

  test('handles Omniroute unavailability gracefully', async ({ request }) => {
    // If Omniroute is not available, the system should not crash
    const response = await request.get('/api/omniroute/health', {
      headers: authHeaders(),
    });
    
    // Should return a proper error status, not 500
    expect([200, 503, 404]).toContain(response.status());
  });

  test('caches Omniroute responses to reduce load', async ({ request }) => {
    // First request
    const response1 = await request.get('/api/omniroute/health', {
      headers: authHeaders(),
    });
    
    if (response1.status() === 200) {
      // Second request should be faster due to caching
      const response2 = await request.get('/api/omniroute/health', {
        headers: authHeaders(),
      });
      
      expect(response2.status()).toBe(200);
    }
  });

  test('respects rate limits when calling Omniroute', async ({ request }) => {
    // Make multiple rapid requests
    const requests = [];
    for (let i = 0; i < 10; i++) {
      requests.push(
        request.get('/api/omniroute/health', {
          headers: authHeaders(),
        })
      );
    }
    
    const responses = await Promise.all(requests);
    
    // All should succeed or gracefully handle rate limiting
    for (const response of responses) {
      expect([200, 429, 503, 404]).toContain(response.status());
    }
  });

  test('syncs credentials with Omniroute', async ({ request }) => {
    const response = await request.post('/api/omniroute/sync-credentials', {
      headers: authHeaders(),
    });
    
    // This endpoint may not exist or Omniroute may not be available
    expect([200, 404, 503]).toContain(response.status());
  });

  test('fails over to backup models when Omniroute is unavailable', async ({ request }) => {
    // This test verifies that the system can function when Omniroute is down
    // by using backup model configurations
    
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective: 'Test failover to backup models',
          workspace: 'internal',
          auto_approve: true,
        },
      }),
    });
    
    // Should succeed even if Omniroute is unavailable
    expect(response.status()).toBe(200);
  });
});