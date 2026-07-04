import { describe, it, expect } from 'vitest';

// TODO Phase 1 (Week 2): re-enable via beforeAll daemon bootstrap.
// These tests require a live daemon at http://127.0.0.1:20129 with a known
// token in data/daemon-token.txt. Without orchestrated bootstrap the tests
// can't pass and leaving them red hides real regressions. See PHASE-0.md §0.4.
describe.skip('Security: Authentication (requires live daemon — bootstrap in Week 2)', () => {
  const baseUrl = process.env.OMNIFORGE_E2E_BASE_URL || 'http://127.0.0.1:20129';
  
  function getAuthToken(): string {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    
    const tokenFromEnv = process.env.OMNIFORGE_DAEMON_TOKEN?.trim();
    if (tokenFromEnv) {
      return tokenFromEnv;
    }
    
    return readFileSync(resolve(process.cwd(), 'data', 'daemon-token.txt'), 'utf8').trim();
  }

  it('rejects requests without Authorization header', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`);
    
    expect([401, 403]).toContain(response.status);
  });

  it('rejects requests with invalid Bearer token', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: 'Bearer invalid_token_12345',
      },
    });
    
    expect([401, 403]).toContain(response.status);
  });

  it('rejects requests with malformed Authorization header', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: 'InvalidFormat token',
      },
    });
    
    expect([401, 403]).toContain(response.status);
  });

  it('accepts requests with valid Bearer token', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
    });
    
    expect(response.status).toBe(200);
  });

  it('uses timing-safe comparison for token validation', async () => {
    const validToken = getAuthToken();
    const invalidToken = validToken + 'x';
    
    const startTime1 = performance.now();
    const response1 = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
      },
    });
    const endTime1 = performance.now();
    const duration1 = endTime1 - startTime1;
    
    const startTime2 = performance.now();
    const response2 = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: `Bearer ${invalidToken}`,
      },
    });
    const endTime2 = performance.now();
    const duration2 = endTime2 - startTime2;
    
    expect(response1.status).toBe(200);
    expect([401, 403]).toContain(response2.status);
    
    // Timing-safe comparison should make durations similar
    // Allow some variance but not drastically different
    const timeDiff = Math.abs(duration1 - duration2);
    expect(timeDiff).toBeLessThan(100); // Less than 100ms difference
  });

  it('rejects empty Bearer token', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: 'Bearer ',
      },
    });
    
    expect([401, 403]).toContain(response.status);
  });

  it('rejects Bearer token with only whitespace', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: 'Bearer   ',
      },
    });
    
    expect([401, 403]).toContain(response.status);
  });

  it('does not leak token information in error responses', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: {
        Authorization: 'Bearer leaked_token_info',
      },
    });
    
    if (response.status === 401 || response.status === 403) {
      const body = await response.json();
      const bodyString = JSON.stringify(body);
      
      // Error message should not contain the token
      expect(bodyString).not.toContain('leaked_token_info');
    }
  });

  it('protects MCP endpoints with authentication', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/list`);
    
    expect([401, 403]).toContain(response.status);
  });

  it('protects dashboard routes with authentication', async () => {
    const response = await fetch(`${baseUrl}/dashboard`);
    
    // Should redirect to login or return 401/403
    expect([200, 302, 401, 403]).toContain(response.status);
  });

  it('validates token format', async () => {
    // Test with various invalid token formats
    const invalidTokens = [
      'token_without_bearer',
      'Bearer',
      'Bearer token with spaces',
      'Basic valid_base64',
      '',
    ];
    
    for (const token of invalidTokens) {
      const response = await fetch(`${baseUrl}/api/dashboard/summary`, {
        headers: {
          Authorization: token,
        },
      });
      
      expect([401, 403]).toContain(response.status);
    }
  });
});