import { describe, it, expect, beforeEach } from 'vitest';
import { useReplStore } from '../../../src/repl/state/store.js';

// Reset store to initial state before each test to ensure isolation.
beforeEach(() => {
  useReplStore.setState({
    session: {
      workspace: 'internal',
      activeModel: null,
      permissionMode: 'default',
      costSession: 0,
      setWorkspace: useReplStore.getState().session.setWorkspace,
      setModel: useReplStore.getState().session.setModel,
      cyclePermissionMode: useReplStore.getState().session.cyclePermissionMode,
      addCost: useReplStore.getState().session.addCost,
      resetSession: useReplStore.getState().session.resetSession,
    },
    workflow: {
      activeWfIds: [],
      currentWfId: null,
      tasksByWfId: {},
      setCurrent: useReplStore.getState().workflow.setCurrent,
      addWorkflow: useReplStore.getState().workflow.addWorkflow,
      upsertTask: useReplStore.getState().workflow.upsertTask,
      removeWorkflow: useReplStore.getState().workflow.removeWorkflow,
    },
    gates: {
      pendingQueue: [],
      head: null,
      enqueueGate: useReplStore.getState().gates.enqueueGate,
      resolveHead: useReplStore.getState().gates.resolveHead,
      peekHead: useReplStore.getState().gates.peekHead,
      removeGate: useReplStore.getState().gates.removeGate,
    },
    ui: {
      focusedPane: 'input',
      modalStack: [],
      modalProps: {},
      theme: 'dark',
      notifications: [],
      setFocus: useReplStore.getState().ui.setFocus,
      pushModal: useReplStore.getState().ui.pushModal,
      popModal: useReplStore.getState().ui.popModal,
      getModalProps: useReplStore.getState().ui.getModalProps,
      pushNotification: useReplStore.getState().ui.pushNotification,
      dismissNotification: useReplStore.getState().ui.dismissNotification,
    },
  });
});

describe('sessionSlice', () => {
  it('setWorkspace changes workspace and preserves other fields', () => {
    const before = useReplStore.getState();
    before.session.setWorkspace('prod');

    const after = useReplStore.getState();
    expect(after.session.workspace).toBe('prod');
    expect(after.session.activeModel).toBe(before.session.activeModel);
    expect(after.session.permissionMode).toBe(before.session.permissionMode);
    expect(after.session.costSession).toBe(before.session.costSession);
  });

  it('cyclePermissionMode cycles through all 4 modes in order', () => {
    const modes = ['default', 'plan-only', 'no-cli', 'safe-mode', 'default'];
    for (let i = 0; i < 4; i++) {
      expect(useReplStore.getState().session.permissionMode).toBe(modes[i]);
      useReplStore.getState().session.cyclePermissionMode();
      expect(useReplStore.getState().session.permissionMode).toBe(modes[i + 1]);
    }
  });

  it('addCost accumulates correctly', () => {
    useReplStore.getState().session.addCost(0.05);
    useReplStore.getState().session.addCost(0.10);
    expect(useReplStore.getState().session.costSession).toBeCloseTo(0.15);
  });

  it('resetSession restores defaults', () => {
    useReplStore.getState().session.setWorkspace('staging');
    useReplStore.getState().session.setModel('gpt-4');
    useReplStore.getState().session.addCost(1.0);
    useReplStore.getState().session.resetSession();

    const s = useReplStore.getState().session;
    expect(s.workspace).toBe('internal');
    expect(s.activeModel).toBeNull();
    expect(s.costSession).toBe(0);
    expect(s.permissionMode).toBe('default');
  });
});

describe('workflowSlice', () => {
  it('addWorkflow adds id and setCurrent sets currentWfId', () => {
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_001', status: 'running' });
    useReplStore.getState().workflow.setCurrent('wf_001');

    const w = useReplStore.getState().workflow;
    expect(w.activeWfIds).toContain('wf_001');
    expect(w.currentWfId).toBe('wf_001');
  });

  it('addWorkflow is idempotent for duplicate ids', () => {
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_dup', status: 'running' });
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_dup', status: 'running' });
    expect(useReplStore.getState().workflow.activeWfIds.filter((id) => id === 'wf_dup')).toHaveLength(1);
  });

  it('upsertTask adds new task when not present', () => {
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_t1', status: 'running' });
    useReplStore.getState().workflow.upsertTask('wf_t1', {
      id: 'task_a',
      name: 'Step A',
      kind: 'llm_call',
      status: 'pending',
    });

    const tasks = useReplStore.getState().workflow.tasksByWfId['wf_t1'];
    expect(tasks).toHaveLength(1);
    expect(tasks![0]!.id).toBe('task_a');
  });

  it('upsertTask updates existing task by id', () => {
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_t2', status: 'running' });
    useReplStore.getState().workflow.upsertTask('wf_t2', {
      id: 'task_b',
      name: 'Step B',
      kind: 'llm_call',
      status: 'pending',
    });
    useReplStore.getState().workflow.upsertTask('wf_t2', {
      id: 'task_b',
      name: 'Step B',
      kind: 'llm_call',
      status: 'completed',
    });

    const tasks = useReplStore.getState().workflow.tasksByWfId['wf_t2'];
    expect(tasks).toHaveLength(1);
    expect(tasks![0]!.status).toBe('completed');
  });

  it('removeWorkflow removes entry and clears currentWfId if matched', () => {
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_rm', status: 'done' });
    useReplStore.getState().workflow.setCurrent('wf_rm');
    useReplStore.getState().workflow.removeWorkflow('wf_rm');

    const w = useReplStore.getState().workflow;
    expect(w.activeWfIds).not.toContain('wf_rm');
    expect(w.currentWfId).toBeNull();
    expect(w.tasksByWfId['wf_rm']).toBeUndefined();
  });
});

describe('gatesSlice', () => {
  it('enqueueGate + resolveHead works FIFO', () => {
    const g1 = { id: 'g1', wfId: 'wf1', taskId: 't1', ts: 100, info: { name: 'Gate 1', kind: 'hitl' } };
    const g2 = { id: 'g2', wfId: 'wf1', taskId: 't2', ts: 200, info: { name: 'Gate 2', kind: 'hitl' } };

    useReplStore.getState().gates.enqueueGate(g1);
    useReplStore.getState().gates.enqueueGate(g2);

    expect(useReplStore.getState().gates.head?.id).toBe('g1');
    useReplStore.getState().gates.resolveHead('approve');
    expect(useReplStore.getState().gates.head?.id).toBe('g2');
    useReplStore.getState().gates.resolveHead('approve');
    expect(useReplStore.getState().gates.head).toBeNull();
    expect(useReplStore.getState().gates.pendingQueue).toHaveLength(0);
  });

  it('peekHead returns current head without mutating', () => {
    const g = { id: 'g_peek', wfId: 'wf1', taskId: 't1', ts: 1, info: { name: 'Peek', kind: 'hitl' } };
    useReplStore.getState().gates.enqueueGate(g);
    const peeked = useReplStore.getState().gates.peekHead();
    expect(peeked?.id).toBe('g_peek');
    expect(useReplStore.getState().gates.pendingQueue).toHaveLength(1);
  });

  it('resolveHead on empty queue is a no-op', () => {
    const before = useReplStore.getState().gates;
    useReplStore.getState().gates.resolveHead('approve');
    const after = useReplStore.getState().gates;
    expect(after.pendingQueue).toHaveLength(0);
    expect(after.head).toBeNull();
    expect(before).toBe(before); // sanity
  });

  it('removeGate removes a gate by id and updates head when removing current head', () => {
    const g1 = { id: 'rg1', wfId: 'wf1', taskId: 't1', ts: 10, info: { name: 'G1', kind: 'hitl' } };
    const g2 = { id: 'rg2', wfId: 'wf1', taskId: 't2', ts: 20, info: { name: 'G2', kind: 'hitl' } };
    const g3 = { id: 'rg3', wfId: 'wf1', taskId: 't3', ts: 30, info: { name: 'G3', kind: 'hitl' } };

    useReplStore.getState().gates.enqueueGate(g1);
    useReplStore.getState().gates.enqueueGate(g2);
    useReplStore.getState().gates.enqueueGate(g3);

    // Remove middle gate — head should remain g1.
    useReplStore.getState().gates.removeGate('rg2');
    expect(useReplStore.getState().gates.pendingQueue.map((g) => g.id)).toEqual(['rg1', 'rg3']);
    expect(useReplStore.getState().gates.head?.id).toBe('rg1');

    // Remove current head — head should become g3.
    useReplStore.getState().gates.removeGate('rg1');
    expect(useReplStore.getState().gates.pendingQueue.map((g) => g.id)).toEqual(['rg3']);
    expect(useReplStore.getState().gates.head?.id).toBe('rg3');

    // Remove last — head should become null.
    useReplStore.getState().gates.removeGate('rg3');
    expect(useReplStore.getState().gates.pendingQueue).toHaveLength(0);
    expect(useReplStore.getState().gates.head).toBeNull();
  });

  it('removeGate with unknown id is a no-op (preserves identity)', () => {
    const g1 = { id: 'noop_g', wfId: 'wf1', taskId: 't1', ts: 1, info: { name: 'G', kind: 'hitl' } };
    useReplStore.getState().gates.enqueueGate(g1);
    const before = useReplStore.getState().gates;
    useReplStore.getState().gates.removeGate('does-not-exist');
    const after = useReplStore.getState().gates;
    expect(after).toBe(before);
  });
});

describe('uiSlice', () => {
  it('pushModal and popModal behave as LIFO stack', () => {
    useReplStore.getState().ui.pushModal('help');
    useReplStore.getState().ui.pushModal('hitl');
    expect(useReplStore.getState().ui.modalStack).toEqual(['help', 'hitl']);

    useReplStore.getState().ui.popModal();
    expect(useReplStore.getState().ui.modalStack).toEqual(['help']);

    useReplStore.getState().ui.popModal();
    expect(useReplStore.getState().ui.modalStack).toEqual([]);
  });

  it('popModal on empty stack is a no-op', () => {
    useReplStore.getState().ui.popModal();
    expect(useReplStore.getState().ui.modalStack).toHaveLength(0);
  });

  it('pushNotification respects cap of 3 (FIFO drop)', () => {
    useReplStore.getState().ui.pushNotification({ kind: 'info', text: 'A', ttl: 3000 });
    useReplStore.getState().ui.pushNotification({ kind: 'info', text: 'B', ttl: 3000 });
    useReplStore.getState().ui.pushNotification({ kind: 'info', text: 'C', ttl: 3000 });
    useReplStore.getState().ui.pushNotification({ kind: 'warn', text: 'D', ttl: 3000 });

    const notifs = useReplStore.getState().ui.notifications;
    expect(notifs).toHaveLength(3);
    // Oldest (A) was dropped; B, C, D remain.
    expect(notifs.map((n) => n.text)).toEqual(['B', 'C', 'D']);
  });

  it('dismissNotification removes by id', () => {
    useReplStore.getState().ui.pushNotification({ kind: 'error', text: 'Oops', ttl: 5000 });
    const id = useReplStore.getState().ui.notifications[0]!.id;
    useReplStore.getState().ui.dismissNotification(id);
    expect(useReplStore.getState().ui.notifications).toHaveLength(0);
  });

  it('setFocus changes focusedPane', () => {
    useReplStore.getState().ui.setFocus('sidePanel');
    expect(useReplStore.getState().ui.focusedPane).toBe('sidePanel');
  });
});

describe('immutability', () => {
  it('state object reference changes after every mutation', () => {
    const s0 = useReplStore.getState();
    useReplStore.getState().session.setWorkspace('test-ws');
    const s1 = useReplStore.getState();
    expect(s0).not.toBe(s1);
    expect(s0.session).not.toBe(s1.session);
  });

  it('workflow state reference changes after upsertTask', () => {
    useReplStore.getState().workflow.addWorkflow({ id: 'wf_imm', status: 'running' });
    const w0 = useReplStore.getState().workflow;
    useReplStore.getState().workflow.upsertTask('wf_imm', {
      id: 'task_imm',
      name: 'Immutable Task',
      kind: 'llm_call',
      status: 'pending',
    });
    const w1 = useReplStore.getState().workflow;
    expect(w0).not.toBe(w1);
    expect(w0.tasksByWfId).not.toBe(w1.tasksByWfId);
  });
});
