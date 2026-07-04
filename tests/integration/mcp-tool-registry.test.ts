/**
 * MCP tool registry — structural smoke (Wave 0.1 / F0-7).
 *
 * Goal: cheap regression guard for the "tool added to inputSchema but never
 * wired into TOOLS" class of bug. Iterates every entry in the exported
 * `TOOLS` constant from `src/mcp/server.ts` and validates that each one is
 * shaped correctly enough for an MCP client to call it.
 *
 * What this test does NOT do:
 *   - It does NOT invoke any tool handler. Per-tool behavior tests live
 *     elsewhere (e.g. tests/integration/advisor-pal-parity.test.ts).
 *   - It does NOT spin up the HTTP daemon. Pure static introspection.
 *
 * Why: the per-tool fan-out below would otherwise need ~57 separate test
 * files. This single fixture catches the most common regression
 * (registration drift) at near-zero cost.
 */
import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../src/mcp/server.js';
import { ADVISOR_NAMES } from '../../src/mcp/tools/advisor_tools.js';

// ── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_COLLABORATION_TOOLS = [
  'omniforge_get_architecture_contract',
  'omniforge_read_task_thread',
  'omniforge_post_task_handoff',
  'omniforge_inspect_workflow_diff',
  'omniforge_create_fix_task',
  'omniforge_request_architecture_review',
  'omniforge_request_product_review',
] as const;

const MINIMUM_TOOL_COUNT = 50;

// ── Suite ────────────────────────────────────────────────────────────────────

describe('MCP tool registry — structural smoke', () => {
  it('exports a non-empty TOOLS array with at least the expected baseline count', () => {
    expect(Array.isArray(TOOLS)).toBe(true);
    // Each non-advisor handler in server.ts switch (~40) + 17 advisors = 57.
    // Guard the lower bound so genuine growth keeps passing while accidental
    // deletion of an entire region is loud.
    expect(TOOLS.length).toBeGreaterThanOrEqual(MINIMUM_TOOL_COUNT);
  });

  it('every registered tool is structurally sane', () => {
    const seenNames = new Set<string>();
    const violations: string[] = [];

    for (const tool of TOOLS) {
      const label = typeof tool?.name === 'string' ? tool.name : '<missing name>';

      if (typeof tool.name !== 'string' || tool.name.length === 0) {
        violations.push(`${label}: name is missing or empty`);
        continue;
      }

      if (!tool.name.startsWith('omniforge_')) {
        violations.push(`${tool.name}: name does not start with omniforge_`);
      }

      if (seenNames.has(tool.name)) {
        violations.push(`${tool.name}: duplicate name in TOOLS`);
      } else {
        seenNames.add(tool.name);
      }

      if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
        violations.push(`${tool.name}: description is missing or empty`);
      }

      const schema = tool.inputSchema as { type?: unknown; properties?: unknown } | undefined;
      if (!schema || typeof schema !== 'object') {
        violations.push(`${tool.name}: inputSchema is missing`);
        continue;
      }
      if (schema.type !== 'object') {
        violations.push(`${tool.name}: inputSchema.type must be "object", got ${String(schema.type)}`);
      }
      // properties may legitimately be empty for parameterless tools, but the
      // key itself must exist as an object so MCP clients can introspect it.
      if (schema.properties === undefined || typeof schema.properties !== 'object') {
        violations.push(`${tool.name}: inputSchema.properties must be an object`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Registered MCP tools failed structural checks:\n  - ${violations.join('\n  - ')}`,
      );
    }
  });

  it('registers every collaboration tool the orchestration plane depends on', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const missing = REQUIRED_COLLABORATION_TOOLS.filter((tool) => !names.has(tool));
    expect(missing).toEqual([]);
  });

  it('registers an MCP tool entry for every native advisor', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const missing = ADVISOR_NAMES
      .map((advisor) => `omniforge_${advisor}`)
      .filter((tool) => !names.has(tool));
    expect(missing).toEqual([]);
  });
});
