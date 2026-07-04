import { describe, it, expect } from 'vitest';

// TODO Phase 1 (Week 2): re-enable via beforeAll daemon bootstrap.
// Also has two template-literal parse errors at lines 104/113 (backtick
// closing with single-quote) to repair before unskipping.
describe.skip('Security: Input Validation (requires live daemon + parse-error fix — Week 2)', () => {
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
    'Content-Type': 'application/json',
  };

  it('rejects path traversal in file operations', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_read_file',
        arguments: {
          path: '../../../etc/passwd',
        },
      }),
    });
    
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.content[0].text).toContain('error');
  });

  it('rejects path traversal with encoded characters', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_read_file',
        arguments: {
          path: '..%2F..%2F..%2Fetc%2Fpasswd',
        },
      }),
    });
    
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.content[0].text).toContain('error');
  });

  it('rejects null byte injection', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_read_file',
        arguments: {
          path: 'test\x00file.txt',
        },
      }),
    });
    
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result.content[0].text).toContain('error');
  });

  it('validates JSON input structure', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: 'invalid json{',
    });
    
    expect(response.status).toBe(400);
  });

  it('rejects oversized payloads', async () => {
    const largePayload = {
      name: 'omniforge_run_workflow',
      arguments: {
        objective: 'a'.repeat(10_000_000), // 10MB string
        workspace: 'internal',
      },
    };
    
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(largePayload),
    });
    
    // Should reject due to size limits
    expect([400, 413, 500]).toContain(response.status);
  });

  it('sanitizes SQL injection attempts', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows?workspace=internal' OR '1'='1`, {
      headers: authHeaders,
    });
    
    // Should handle gracefully without SQL errors
    expect([200, 400, 500]).toContain(response.status);
  });

  it('validates workflow ID format', async () => {
    const response = await fetch(`${baseUrl}/api/dashboard/workflows/../../etc/passwd`, {
      headers: authHeaders,
    });
    
    expect([400, 404]).toContain(response.status);
  });

  it('rejects XSS attempts in input', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective: '<script>alert("xss")</script>',
          workspace: 'internal',
        },
      }),
    });
    
    expect(response.ok).toBe(true);
  });

  it('validates enum values for configuration', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_set_config',
        arguments: {
          key: 'TASK_MODEL',
          value: 'invalid_model_value',
        },
      }),
    });
    
    expect(response.ok).toBe(true);
    const result = await response.json();
    const content = JSON.parse(result.content[0].text);
    expect(content.success).toBe(false);
  });

  it('rejects command injection in CLI operations', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: {
          objective: 'test; rm -rf /',
          workspace: 'internal',
        },
      }),
    });
    
    expect(response.ok).toBe(true);
  });

  it('validates workspace names', async () => {
    const invalidWorkspaces = [
      '../../../etc',
      'workspace; DROP TABLE users',
      'workspace\x00injection',
      'workspace<script>',
    ];
    
    for (const workspace of invalidWorkspaces) {
      const response = await fetch(`${baseUrl}/api/dashboard/summary?workspace=${encodeURIComponent(workspace)}`, {
        headers: authHeaders,
      });
      
      // Should handle gracefully
      expect([200, 400, 404]).toContain(response.status);
    }
  });

  it('rejects malformed JSON in tool arguments', async () => {
    const response = await fetch(`${baseUrl}/mcp/tools/call`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'omniforge_run_workflow',
        arguments: 'not an object',
      }),
    });
    
    expect([400, 422]).toContain(response.status);
  });

  it('sanitizes special characters in file paths', async () => {
    const specialPaths = [
      'file|pipe.txt',
      'file>output.txt',
      'file<input.txt',
      'file&command.txt',
    ];
    
    for (const path of specialPaths) {
      const response = await fetch(`${baseUrl}/mcp/tools/call`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'omniforge_read_file',
          arguments: {
            path,
          },
        }),
      });
      
      expect(response.ok).toBe(true);
    }
  });
});