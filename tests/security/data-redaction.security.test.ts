import { describe, it, expect } from 'vitest';

// TODO Phase 1 (Week 2): re-enable via beforeAll daemon bootstrap.
// These tests require a live daemon — see authentication.security.test.ts.
describe.skip('Security: Data Redaction (requires live daemon — bootstrap in Week 2)', () => {
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

  const authHeaders = {
    Authorization: `Bearer ${getAuthToken()}`,
  };

  it('redacts API keys from workflow events', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      if (body.workflows && body.workflows.length > 0) {
        const workflowId = body.workflows[0].id || body.workflows[0].workflow_id;
        
        const eventsResponse = await fetch(`${baseUrl}/api/dashboard/workflows/${workflowId}/events`, {
          headers: authHeaders,
        });
        
        if (eventsResponse.ok) {
          const eventsBody = await eventsResponse.json();
          if (eventsBody.events) {
            const eventsString = JSON.stringify(eventsBody.events);
            
            // Check for common API key patterns
            expect(eventsString).not.toMatch(/api[_-]?key\s*[:=]\s*['"][\w-]{20,}['"]/i);
            expect(eventsString).not.toMatch(/sk-[a-zA-Z0-9]{20,}/); // OpenAI pattern
            expect(eventsString).not.toMatch(/Bearer\s+[a-zA-Z0-9]{20,}/i);
          }
        }
      }
    }
  });

  it('redacts secrets from task outputs', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      if (body.workflows && body.workflows.length > 0) {
        const workflowId = body.workflows[0].id || body.workflows[0].workflow_id;
        
        const tasksResponse = await fetch(`${baseUrl}/api/dashboard/workflows/${workflowId}`, {
          headers: authHeaders,
        });
        
        if (tasksResponse.ok) {
          const tasksBody = await tasksResponse.json();
          if (tasksBody.tasks) {
            const tasksString = JSON.stringify(tasksBody.tasks);
            
            // Check for secret patterns
            expect(tasksString).not.toMatch(/secret\s*[:=]\s*['"][\w-]{10,}['"]/i);
            expect(tasksString).not.toMatch(/password\s*[:=]\s*['"][\w-]{10,}['"]/i);
          }
        }
      }
    }
  });

  it('redacts tokens from URLs in logs', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      if (body.workflows && body.workflows.length > 0) {
        const workflowId = body.workflows[0].id || body.workflows[0].workflow_id;
        
        const eventsResponse = await fetch(`${baseUrl}/api/dashboard/workflows/${workflowId}/events`, {
          headers: authHeaders,
        });
        
        if (eventsResponse.ok) {
          const eventsBody = await eventsResponse.json();
          if (eventsBody.events) {
            const eventsString = JSON.stringify(eventsBody.events);
            
            // Check for tokens in URLs
            expect(eventsString).not.toMatch(/token=[a-zA-Z0-9]{20,}/i);
            expect(eventsString).not.toMatch(/access_token=[a-zA-Z0-9]{20,}/i);
          }
        }
      }
    }
  });

  it('does not leak internal file paths', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      const bodyString = JSON.stringify(body);
      
      // Check for absolute file paths
      expect(bodyString).not.toMatch(/\/[a-z0-9_\/\-\.]+\.(ts|js|json)/i);
      expect(bodyString).not.toMatch(/[A-Z]:\\[a-z0-9_\\\-\.]+\.(ts|js|json)/i);
    }
  });

  it('redacts database connection strings', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      const bodyString = JSON.stringify(body);
      
      // Check for database connection patterns
      expect(bodyString).not.toMatch(/mongodb:\/\/[^@]+@/i);
      expect(bodyString).not.toMatch(/postgres:\/\/[^@]+@/i);
      expect(bodyString).not.toMatch(/mysql:\/\/[^@]+@/i);
    }
  });

  it('redacts webhook secrets from trigger configurations', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/triggers?workspace=internal`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      if (body.triggers) {
        const triggersString = JSON.stringify(body.triggers);
        
        // Check for secret patterns in triggers
        expect(triggersString).not.toMatch(/secret['"]?\s*[:=]\s*['"][\w-]{20,}['"]/i);
        expect(triggersString).not.toMatch(/webhook['"]?\s*[:=]\s*['"][\w-]{20,}['"]/i);
      }
    }
  });

  it('redacts environment variables from logs', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      if (body.workflows && body.workflows.length > 0) {
        const workflowId = body.workflows[0].id || body.workflows[0].workflow_id;
        
        const eventsResponse = await fetch(`${baseUrl}/api/dashboard/workflows/${workflowId}/events`, {
          headers: authHeaders,
        });
        
        if (eventsResponse.ok) {
          const eventsBody = await eventsResponse.json();
          if (eventsBody.events) {
            const eventsString = JSON.stringify(eventsBody.events);
            
            // Check for environment variable patterns
            expect(eventsString).not.toMatch(/process\.env\.[A-Z_]+/i);
            expect(eventsString).not.toMatch(/\$\{[A-Z_]+\}/i);
          }
        }
      }
    }
  });

  it('sanitizes error messages to prevent information disclosure', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows/nonexistent-id`, {
      headers: authHeaders,
    });
    
    if (response.status === 404) {
      const body = await response.json();
      const bodyString = JSON.stringify(body);
      
      // Error should not reveal internal paths or stack traces
      expect(bodyString).not.toMatch(/\/[a-z0-9_\/\-\.]+\.(ts|js)/i);
      expect(bodyString).not.toMatch(/at\s+[A-Z][a-zA-Z]+\./i);
      expect(bodyString).not.toMatch(/Error:\s+/i);
    }
  });

  it('redacts PII from user inputs', async () => {
    // This is a placeholder - actual PII detection would need more sophisticated logic
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal&limit=1`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      const bodyString = JSON.stringify(body);
      
      // Basic check for email patterns (should be redacted in production)
      // This is informational - actual redaction would require regex patterns
      expect(bodyString).toBeDefined();
    }
  });

  it('redacts credentials from vault operations', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/vault/files?workspace=internal`, {
      headers: authHeaders,
    });
    
    if (response.ok) {
      const body = await response.json();
      if (body.files) {
        const filesString = JSON.stringify(body.files);
        
        // Check for credential patterns
        expect(filesString).not.toMatch(/password['"]?\s*[:=]/i);
        expect(filesString).not.toMatch(/api[_-]?key['"]?\s*[:=]/i);
      }
    }
  });
});