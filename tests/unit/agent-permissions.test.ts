/**
 * Per-persona tool permission map — resolveToolPermission + runner wiring.
 */

import { describe, expect, it } from 'vitest';

import {
  PermissionDeniedError,
  enforcePersonaToolPermissions,
  resolveToolPermission,
} from '../../src/v2/agents/permissions.js';
import {
  createInMemoryContext,
  runAgent,
  DECOMPOSER_PERSONA,
  REVIEWER_PERSONA,
  WORKER_TOOL_CALL_PERSONA,
  type WorkerToolCallInput,
} from '../../src/v2/agents/index.js';

describe('resolveToolPermission', () => {
  it('prefers exact match over glob patterns', () => {
    const map = { Read: 'allow', 'Re*': 'deny' } as const;
    expect(resolveToolPermission(map, 'Read', 'deny')).toBe('allow');
  });

  it('uses literal * map entry before defaultAction', () => {
    const map = { '*': 'allow', Bash: 'deny' } as const;
    expect(resolveToolPermission(map, 'Write', 'deny')).toBe('allow');
    expect(resolveToolPermission(map, 'Bash', 'allow')).toBe('deny');
  });

  it('falls back to defaultAction when nothing matches', () => {
    expect(resolveToolPermission({}, 'Anything', 'ask')).toBe('ask');
    expect(resolveToolPermission(undefined, 'X', 'deny')).toBe('deny');
  });

  it('matches glob wildcards', () => {
    const map = { 'Write*': 'deny' as const };
    expect(resolveToolPermission(map, 'WriteFile', 'allow')).toBe('deny');
    expect(resolveToolPermission(map, 'Read', 'allow')).toBe('allow');
  });
});

describe('reviewer persona permissions', () => {
  it('allows Read/Grep/Bash/Glob and denies Write via defaultAction', () => {
    const p = REVIEWER_PERSONA.permissions!;
    expect(resolveToolPermission(p.tools, 'Read', p.defaultAction)).toBe('allow');
    expect(resolveToolPermission(p.tools, 'Glob', p.defaultAction)).toBe('allow');
    expect(resolveToolPermission(p.tools, 'Write', p.defaultAction)).toBe('deny');
    expect(resolveToolPermission(p.tools, 'Edit', p.defaultAction)).toBe('deny');
  });
});

describe('decomposer persona permissions', () => {
  it('denies Bash while default allow stands for other tools', () => {
    const p = DECOMPOSER_PERSONA.permissions!;
    expect(resolveToolPermission(p.tools, 'Bash', p.defaultAction)).toBe('deny');
    expect(resolveToolPermission(p.tools, 'Read', p.defaultAction)).toBe('allow');
  });
});

describe('enforcePersonaToolPermissions', () => {
  it('throws PermissionDeniedError when an allowlisted tool is denied', () => {
    expect(() =>
      enforcePersonaToolPermissions(
        'worker.cli_spawn',
        ['Write'],
        { defaultAction: 'deny', tools: { Read: 'allow' } },
        () => {},
        {},
      ),
    ).toThrow(PermissionDeniedError);
  });

  it('emits permission_ask before deny checks complete', () => {
    const payloads: Record<string, unknown>[] = [];
    enforcePersonaToolPermissions(
      'worker.tool_call',
      ['Bash', 'Read'],
      WORKER_TOOL_CALL_PERSONA.permissions,
      (_ev, p) => payloads.push(p),
      { workflowId: 'wf1', taskId: 'ta1' },
    );
    expect(payloads.some((p) => p['tool'] === 'Bash')).toBe(true);
    expect(payloads.every((p) => p['agent_id'] === 'worker.tool_call')).toBe(true);
  });
});

describe('runAgent permission wiring', () => {
  it('emits permission_ask for Bash on worker.tool_call before invoke', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });
    const input: WorkerToolCallInput = {
      task_id: 'tk_z',
      tool_name: 'file_read',
      args: { path: 'README.md' },
      workspace_dir: process.cwd(),
    };
    await runAgent(WORKER_TOOL_CALL_PERSONA, input, ctx, {
      invoke: async () =>
        JSON.stringify({
          tool_name: 'file_read',
          result: null,
          duration_ms: 0,
        }),
      parseJson: true,
    });

    const ask = ctx.events.filter((e) => e.event === 'permission_ask');
    expect(ask.length).toBeGreaterThanOrEqual(1);
    expect(ask.some((e) => e.payload['tool'] === 'Bash')).toBe(true);
    expect(ctx.events.findIndex((e) => e.event === 'agent_started')).toBeLessThan(
      ctx.events.findIndex((e) => e.event === 'permission_ask'),
    );
  });
});
