/**
 * Aurora-parity Wave 0 (WS3): per-task tool allowlist — the scoping substrate
 * for unattended / sub-agent / constrained runs. When a tool_call task declares
 * `allowed_tools`, it may ONLY invoke those tools; everything else is auto-denied
 * before resolution/execution. Absent => inherit-all (no behaviour change).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { isToolAllowed } from '../../src/v2/tools/registry.js';

describe('isToolAllowed (pure predicate)', () => {
  it('inherits all when allowedTools is undefined (default, no scoping)', () => {
    expect(isToolAllowed('bash', undefined)).toBe(true);
    expect(isToolAllowed('file-write', undefined)).toBe(true);
  });
  it('allows a tool present in the list', () => {
    expect(isToolAllowed('file-read', ['file-read', 'grep'])).toBe(true);
  });
  it('denies a tool absent from the list', () => {
    expect(isToolAllowed('bash', ['file-read', 'grep'])).toBe(false);
  });
  it('denies everything for an empty allowlist (fully locked down agent)', () => {
    expect(isToolAllowed('file-read', [])).toBe(false);
  });
});

// ── runToolCallTask denial path ──────────────────────────────────────────────
// The allowlist gate fires BEFORE resolveTool/execute, so a denied tool never
// runs. Stub the DB layer so the audit insertEvent path runs without a real DB.

const { events } = vi.hoisted(() => ({ events: [] as Array<{ type: string; payload: unknown }> }));

vi.mock('../../src/db/client.js', () => ({ initDb: () => ({ close: () => {} }) }));
vi.mock('../../src/db/persist.js', () => ({
  insertEvent: (_db: unknown, ev: { type: string; payload: unknown }) => { events.push(ev); },
}));

describe('runToolCallTask — allowlist enforcement', () => {
  beforeEach(() => { events.length = 0; });

  function task(toolName: string, allowedTools?: string[]) {
    const input: Record<string, unknown> = { tool_name: toolName, args: {}, workspace: 'internal' };
    if (allowedTools !== undefined) input['allowed_tools'] = allowedTools;
    return {
      id: 't1', workflow_id: 'wf-1', name: 'tool task', kind: 'tool_call',
      input_json: JSON.stringify(input), output_json: null, status: 'running',
      depends_on: [], executor_hint: null, timeout_seconds: 300, max_retries: 3,
      retry_count: 0, retry_policy: 'exponential', started_at: null, completed_at: null,
      created_at: Date.now(), acceptance_criteria: null, tool_name: toolName,
    };
  }

  it('denies a tool not in allowed_tools BEFORE execution and audits the block', async () => {
    const { runToolCallTask } = await import('../../src/executors/tool.js');
    await expect(
      runToolCallTask(task('bash', ['file-read']) as never),
    ).rejects.toThrow(/denied: not in this task's allowed_tools/i);
    const blocked = events.find((e) => e.type === 'tool_blocked_by_allowlist');
    expect(blocked).toBeTruthy();
    expect((blocked!.payload as { tool: string }).tool).toBe('bash');
  });
});
