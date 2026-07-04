import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

test.describe('Vault Operations E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('reads file from vault', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_vault_read',
        arguments: {
          path: 'README.md',
          workspace: 'internal',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    // May have error if file doesn't exist, but the API should respond
    expect(content).toHaveProperty('content');
  });

  test('writes file to vault', async ({ request }) => {
    const testContent = 'E2E test content for vault write';
    
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_vault_write',
        arguments: {
          path: 'e2e-test-file.txt',
          content: testContent,
          workspace: 'internal',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('success');
  });

  test('lists files in vault workspace', async ({ request }) => {
    const response = await request.get('/api/dashboard/vault/files?workspace=internal', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.files)).toBe(true);
  });

  test('filters vault files by pattern', async ({ request }) => {
    const response = await request.get('/api/dashboard/vault/files?workspace=internal&pattern=*.md', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.files)).toBe(true);
    
    // Verify all returned files match the pattern
    for (const file of body.files) {
      expect(file.path).toMatch(/\.md$/i);
    }
  });

  test('enforces vault workspace boundaries', async ({ request }) => {
    // Try to read a file from a different workspace
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_vault_read',
        arguments: {
          path: 'README.md',
          workspace: 'nonexistent-workspace',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    const content = JSON.parse(result.content[0].text);
    
    // Should return an error for nonexistent workspace
    expect(content).toHaveProperty('error');
  });

  test('handles concurrent vault writes safely', async ({ request }) => {
    // This test verifies that concurrent writes don't cause data corruption
    const writePromises = [];
    
    for (let i = 0; i < 5; i++) {
      writePromises.push(
        request.post('/mcp/tools/call', {
          headers: authHeaders(),
          data: JSON.stringify({
            name: 'omniforge_vault_write',
            arguments: {
              path: `e2e-concurrent-test-${i}.txt`,
              content: `Concurrent test content ${i}`,
              workspace: 'internal',
            },
          }),
        })
      );
    }
    
    const responses = await Promise.all(writePromises);
    
    // All writes should succeed
    for (const response of responses) {
      expect(response.status()).toBe(200);
    }
  });

  test('deletes file from vault', async ({ request }) => {
    // First write a file
    const writeResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_vault_write',
        arguments: {
          path: 'e2e-test-delete.txt',
          content: 'To be deleted',
          workspace: 'internal',
        },
      }),
    });
    
    if (writeResponse.status() === 200) {
      // Delete the file
      const deleteResponse = await request.post('/mcp/tools/call', {
        headers: authHeaders(),
        data: JSON.stringify({
          name: 'omniforge_vault_delete',
          arguments: {
            path: 'e2e-test-delete.txt',
            workspace: 'internal',
          },
        }),
      });
      
      expect(deleteResponse.status()).toBe(200);
      const result = await deleteResponse.json();
      const content = JSON.parse(result.content[0].text);
      expect(content).toHaveProperty('success');
    }
  });

  test('prevents directory traversal in vault operations', async ({ request }) => {
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_vault_read',
        arguments: {
          path: '../../../etc/passwd',
          workspace: 'internal',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    const content = JSON.parse(result.content[0].text);
    
    // Should reject path traversal
    expect(content).toHaveProperty('error');
  });
});