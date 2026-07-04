import { expect, test } from '@playwright/test';
import { getToken } from './_helpers';

test.describe('Pattern Operations E2E', () => {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  test('lists patterns by workspace', async ({ request }) => {
    const response = await request.get('/api/dashboard/patterns?workspace=internal', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.patterns)).toBe(true);
  });

  test('saves a completed workflow as a pattern', async ({ request }) => {
    // First, we need a completed workflow
    // For E2E, we'll use the list to find a completed workflow
    
    const listResponse = await request.get('/api/dashboard/workflows?workspace=internal&status=completed&limit=1', {
      headers: authHeaders(),
    });
    
    if (listResponse.status() === 200) {
      const listResult = await listResponse.json();
      const workflows = listResult.workflows;
      
      if (workflows && workflows.length > 0) {
        const workflowId = workflows[0].id || workflows[0].workflow_id;
        
        // Save as pattern
        const saveResponse = await request.post('/mcp/tools/call', {
          headers: authHeaders(),
          data: JSON.stringify({
            name: 'omniforge_save_pattern',
            arguments: {
              workflow_id: workflowId,
              pattern_name: 'E2E Test Pattern',
              workspace: 'internal',
            },
          }),
        });
        
        expect(saveResponse.status()).toBe(200);
        const saveResult = await saveResponse.json();
        expect(saveResult).toHaveProperty('content');
        
        const content = JSON.parse(saveResult.content[0].text);
        expect(content).toHaveProperty('pattern_id');
      }
    }
  });

  test('exports a pattern as portable DAG', async ({ request }) => {
    // First get a pattern
    const listResponse = await request.get('/api/dashboard/patterns?workspace=internal&limit=1', {
      headers: authHeaders(),
    });
    
    if (listResponse.status() === 200) {
      const listResult = await listResponse.json();
      const patterns = listResult.patterns;
      
      if (patterns && patterns.length > 0) {
        const patternId = patterns[0].id;
        
        // Export pattern
        const exportResponse = await request.post('/mcp/tools/call', {
          headers: authHeaders(),
          data: JSON.stringify({
            name: 'omniforge_export_pattern',
            arguments: {
              pattern_id: patternId,
            },
          }),
        });
        
        expect(exportResponse.status()).toBe(200);
        const exportResult = await exportResponse.json();
        expect(exportResult).toHaveProperty('content');
        
        const content = JSON.parse(exportResult.content[0].text);
        expect(content).toHaveProperty('dag_json');
        expect(content).toHaveProperty('pattern_name');
      }
    }
  });

  test('imports a pattern from portable DAG', async ({ request }) => {
    const portableDag = {
      tasks: [
        {
          id: 'task_1',
          name: 'Test task',
          kind: 'llm_call',
          depends_on: [],
          model: 'cx/gpt-5.4',
          acceptance_criteria: 'Test criteria',
        },
      ],
    };
    
    const response = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_import_pattern',
        arguments: {
          dag_json: JSON.stringify(portableDag),
          pattern_name: 'E2E Imported Pattern',
          workspace: 'internal',
        },
      }),
    });
    
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty('content');
    
    const content = JSON.parse(result.content[0].text);
    expect(content).toHaveProperty('pattern_id');
  });

  test('deletes a pattern', async ({ request }) => {
    // First create a pattern by importing one
    const portableDag = {
      tasks: [
        {
          id: 'task_1',
          name: 'Test task to delete',
          kind: 'llm_call',
          depends_on: [],
          model: 'cx/gpt-5.4',
          acceptance_criteria: 'Test criteria',
        },
      ],
    };
    
    const importResponse = await request.post('/mcp/tools/call', {
      headers: authHeaders(),
      data: JSON.stringify({
        name: 'omniforge_import_pattern',
        arguments: {
          dag_json: JSON.stringify(portableDag),
          pattern_name: 'E2E Pattern to Delete',
          workspace: 'internal',
        },
      }),
    });
    
    if (importResponse.status() === 200) {
      const importResult = await importResponse.json();
      const content = JSON.parse(importResult.content[0].text);
      const patternId = content.pattern_id;
      
      // Delete the pattern
      const deleteResponse = await request.delete(`/api/dashboard/patterns/${patternId}`, {
        headers: authHeaders(),
      });
      
      expect(deleteResponse.status()).toBe(200);
      
      // Verify it's deleted
      const getResponse = await request.get(`/api/dashboard/patterns/${patternId}`, {
        headers: authHeaders(),
      });
      
      expect(getResponse.status()).toBe(404);
    }
  });

  test('shows pattern usage statistics', async ({ request }) => {
    const response = await request.get('/api/dashboard/patterns?workspace=internal', {
      headers: authHeaders(),
    });
    
    expect(response.status()).toBe(200);
    const body = await response.json();
    
    if (body.patterns && body.patterns.length > 0) {
      const firstPattern = body.patterns[0];
      expect(firstPattern).toHaveProperty('usage_count');
      expect(firstPattern).toHaveProperty('success_count');
      expect(firstPattern).toHaveProperty('avg_duration_ms');
    }
  });
});