import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { HitlModal } from '../../../src/repl/modal/HitlModal.js';
import type { Gate } from '../../../src/repl/state/gatesSlice.js';
import type { PlanContext } from '../../../src/hitl/cli.js';

const noopHandlers = {
  onApprove: () => {},
  onReject: () => {},
  onModify: () => {},
  onBackground: () => {},
};

function makeGate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: 'gate_test_1',
    wfId: 'wf_aaaa15ef',
    taskId: 't3',
    ts: 1700000000000,
    info: {
      name: 'Implement HitlModal real',
      kind: 'cli_spawn',
      model: 'claude/claude-sonnet-4-6',
      executorHint: 'cli:claude-code',
      timeoutSeconds: 600,
      acceptanceCriteria: 'All tests pass; no placeholder text remains.',
    },
    ...overrides,
  };
}

function makePlanContext(): PlanContext {
  return {
    workflowId: 'wf_plan_test',
    objective: 'Build a TODO app with three tasks: spec, code, deploy.',
    tasks: [
      { id: 'tk0', name: 'Plan',      kind: 'llm_call',  depends_on: [],       timeoutSeconds: 60 },
      { id: 'tk1', name: 'Implement', kind: 'cli_spawn', depends_on: ['tk0'],  timeoutSeconds: 300 },
      { id: 'tk2', name: 'Review',    kind: 'llm_call',  depends_on: ['tk1'],  timeoutSeconds: 90 },
    ],
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// Render + flush so Ink useEffect attaches useInput listeners before stdin writes.
async function renderAndWire(node: React.ReactElement): Promise<ReturnType<typeof render>> {
  const inst = render(node);
  await flush();
  return inst;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('HitlModal', () => {
  it('renders gate task name + kind + acceptance criteria', () => {
    const gate = makeGate();
    const inst = render(
      React.createElement(HitlModal, {
        gate,
        queueDepth: 1,
        ...noopHandlers,
      }),
    );
    const out = stripAnsi(inst.lastFrame() ?? '');
    expect(out).toContain('HITL Gate');
    expect(out).toContain('wf:wf_aaaa15ef');
    expect(out).toContain('Implement HitlModal real');
    expect(out).toContain('cli_spawn');
    expect(out).toContain('cli:claude-code');
    expect(out).toContain('Critério:');
    expect(out).toContain('All tests pass');
    inst.unmount();
  });

  it('renders queueDepth in the header (2/N)', () => {
    const gate = makeGate();
    const inst = render(
      React.createElement(HitlModal, {
        gate,
        queueDepth: 4,
        ...noopHandlers,
      }),
    );
    const out = stripAnsi(inst.lastFrame() ?? '');
    expect(out).toContain('1/4');
    inst.unmount();
  });

  it('Y key dispatches onApprove', async () => {
    const onApprove = vi.fn();
    const inst = await renderAndWire(
      React.createElement(HitlModal, {
        gate: makeGate(),
        queueDepth: 1,
        ...noopHandlers,
        onApprove,
      }),
    );
    inst.stdin.write('y');
    await flush();
    expect(onApprove).toHaveBeenCalledTimes(1);
    inst.unmount();
  });

  it('ENTER alone in idle mode is a noop (does not approve)', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const inst = await renderAndWire(
      React.createElement(HitlModal, {
        gate: makeGate(),
        queueDepth: 1,
        ...noopHandlers,
        onApprove,
        onReject,
      }),
    );
    // CR alone — Ink reports as key.return.
    inst.stdin.write('\r');
    await flush();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('R then y+Enter confirms reject; R then Esc cancels', async () => {
    const onReject = vi.fn();
    const inst = await renderAndWire(
      React.createElement(HitlModal, {
        gate: makeGate(),
        queueDepth: 1,
        ...noopHandlers,
        onReject,
      }),
    );

    // Press R → enter confirming-reject mode (visible "Confirm reject?").
    inst.stdin.write('r');
    await flush();
    expect(stripAnsi(inst.lastFrame() ?? '')).toContain('Confirm reject?');

    // Esc cancels — back to idle, no reject dispatched.
    inst.stdin.write('\u001B');
    await flush();
    expect(onReject).not.toHaveBeenCalled();
    expect(stripAnsi(inst.lastFrame() ?? '')).not.toContain('Confirm reject?');

    // Press R again, then y + Enter → reject fires.
    inst.stdin.write('r');
    await flush();
    inst.stdin.write('y');
    await flush();
    inst.stdin.write('\r');
    await flush();
    expect(onReject).toHaveBeenCalledTimes(1);

    inst.unmount();
  });

  it('M opens modify text area; Enter submits onModify(text)', async () => {
    const onModify = vi.fn();
    const inst = await renderAndWire(
      React.createElement(HitlModal, {
        gate: makeGate(),
        queueDepth: 1,
        ...noopHandlers,
        onModify,
      }),
    );

    inst.stdin.write('m');
    await flush();
    expect(stripAnsi(inst.lastFrame() ?? '')).toContain('Modify task');

    // Type the refinement, then Enter.
    inst.stdin.write('add unit tests');
    await flush();
    inst.stdin.write('\r');
    await flush();

    expect(onModify).toHaveBeenCalledTimes(1);
    expect(onModify.mock.calls[0]?.[0]).toBe('add unit tests');
    inst.unmount();
  });

  it('Esc in idle dispatches onBackground', async () => {
    const onBackground = vi.fn();
    const onApprove = vi.fn();
    const inst = await renderAndWire(
      React.createElement(HitlModal, {
        gate: makeGate(),
        queueDepth: 2,
        ...noopHandlers,
        onApprove,
        onBackground,
      }),
    );
    inst.stdin.write('\u001B');
    await flush();
    expect(onBackground).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('plan-gate renders DAG completo when planContext is set', () => {
    const gate = makeGate({
      info: {
        name: 'Plan',
        kind: 'llm_call',
        timeoutSeconds: 60,
        planContext: makePlanContext(),
      },
    });
    const inst = render(
      React.createElement(HitlModal, {
        gate,
        queueDepth: 1,
        ...noopHandlers,
      }),
    );
    const out = stripAnsi(inst.lastFrame() ?? '');
    expect(out).toContain('DAG completo proposto');
    expect(out).toContain('3 tasks');
    expect(out).toContain('Objetivo: Build a TODO app');
    expect(out).toContain('Plan');
    expect(out).toContain('Implement');
    expect(out).toContain('Review');
    // Critical path = 60 + 300 + 90 = 450s = 8min (rounded).
    expect(out).toMatch(/caminho crítico ~\d+min/);
    inst.unmount();
  });
});
