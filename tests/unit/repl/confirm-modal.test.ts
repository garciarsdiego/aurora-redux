import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ConfirmModal } from '../../../src/repl/modal/ConfirmModal.js';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function renderAndWire(node: React.ReactElement): Promise<ReturnType<typeof render>> {
  const inst = render(node);
  await flush();
  return inst;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('ConfirmModal', () => {
  it('renders the prompt + default y/n hint with Enter = n by default', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const inst = render(
      React.createElement(ConfirmModal, {
        prompt: 'Cancel running workflow wf_123?',
        onConfirm,
        onCancel,
      }),
    );
    const out = stripAnsi(inst.lastFrame() ?? '');
    expect(out).toContain('Cancel running workflow wf_123?');
    expect(out).toContain('[y/n]');
    expect(out).toContain('Enter = n');
    inst.unmount();
  });

  it('ENTER on empty input invokes the default action (cancel by default)', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const inst = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Drop pattern?',
        onConfirm,
        onCancel,
      }),
    );

    inst.stdin.write('\r');
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('defaultAction "y" makes ENTER fire onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const inst = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Save and exit?',
        defaultAction: 'y' as const,
        onConfirm,
        onCancel,
      }),
    );
    inst.stdin.write('\r');
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('Esc dispatches onCancel from any state', async () => {
    const onCancel = vi.fn();
    const inst = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Proceed?',
        onConfirm: () => {},
        onCancel,
      }),
    );
    inst.stdin.write('\u001B');
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    inst.unmount();
  });

  it('destructive=true uses warning glyph and prompts user', () => {
    const destructiveInst = render(
      React.createElement(ConfirmModal, {
        prompt: 'Delete database?',
        destructive: true,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    const destructiveOut = stripAnsi(destructiveInst.lastFrame() ?? '');
    expect(destructiveOut).toContain('\u26A0');
    expect(destructiveOut).toContain('Delete database?');
    destructiveInst.unmount();

    // Non-destructive variant uses the question mark glyph instead.
    const niceInst = render(
      React.createElement(ConfirmModal, {
        prompt: 'Save changes?',
        destructive: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    const niceOut = stripAnsi(niceInst.lastFrame() ?? '');
    expect(niceOut).not.toContain('\u26A0');
    expect(niceOut).toContain('Save changes?');
    niceInst.unmount();
  });

  it('requireText: wrong submission shows mismatch + does not confirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const inst = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Enable danger auto-approve?',
        requireText: 'I understand',
        destructive: true,
        onConfirm,
        onCancel,
      }),
    );

    expect(stripAnsi(inst.lastFrame() ?? '')).toContain('Type exactly');
    expect(stripAnsi(inst.lastFrame() ?? '')).toContain('I understand');

    inst.stdin.write('I undestand');
    await flush();
    inst.stdin.write('\r');
    await flush();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(stripAnsi(inst.lastFrame() ?? '')).toContain('exact match required');
    inst.unmount();
  });

  it('requireText: exact text submission fires onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const inst = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Enable danger auto-approve?',
        requireText: 'go',
        destructive: true,
        onConfirm,
        onCancel,
      }),
    );

    inst.stdin.write('go');
    await flush();
    inst.stdin.write('\r');
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    inst.unmount();
  });

  it('y / n keys (no requireText) dispatch the right callbacks', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const inst = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Continue?',
        onConfirm,
        onCancel,
      }),
    );
    inst.stdin.write('y');
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // Second instance: confirm n cancels.
    const onConfirm2 = vi.fn();
    const onCancel2 = vi.fn();
    const inst2 = await renderAndWire(
      React.createElement(ConfirmModal, {
        prompt: 'Again?',
        onConfirm: onConfirm2,
        onCancel: onCancel2,
      }),
    );
    inst2.stdin.write('n');
    await flush();
    expect(onCancel2).toHaveBeenCalledTimes(1);

    inst.unmount();
    inst2.unmount();
  });
});
