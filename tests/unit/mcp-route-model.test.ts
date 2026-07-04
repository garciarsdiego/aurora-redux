import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../src/mcp/server.js';
import {
  RouteModelSchema,
  routeModelTool,
} from '../../src/mcp/tools/route_model.js';

describe('omniforge_route_model MCP tool', () => {
  it('is registered in the MCP tool list', () => {
    expect(TOOLS.map((t) => t.name)).toContain('omniforge_route_model');
  });

  it('parses routing constraints', () => {
    const parsed = RouteModelSchema.parse({
      use_case: 'Código Complexo',
      strategy: 'quality',
      required_capabilities: ['tool_calling', 'structured_output'],
      limit: 3,
    });
    expect(parsed.required_capabilities).toEqual(['tool_calling', 'structured_output']);
    expect(parsed.limit).toBe(3);
  });

  it('returns a selected model plus ranked candidates', async () => {
    const result = JSON.parse(await routeModelTool({
      use_case: 'Tarefa Rápida',
      strategy: 'cost',
      limit: 5,
    })) as { selected: { model_id: string }; candidates: unknown[] };

    expect(result.selected.model_id).toContain('/');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });
});
