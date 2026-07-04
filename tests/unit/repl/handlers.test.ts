import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { ReplCtx } from '../../../src/repl/commands/types.js';
import { clearRegistry } from '../../../src/repl/commands/registry.js';
import { initDb } from '../../../src/db/client.js';
import { useReplStore, type ReplStore } from '../../../src/repl/state/store.js';
import { resetOutputBuffer, getOutputSnapshot, appendOutput } from '../../../src/repl/state/outputBuffer.js';

// Handlers
import { helpCommand } from '../../../src/repl/commands/handlers/help.js';
import { exitCommand } from '../../../src/repl/commands/handlers/exit.js';
import { statusCommand } from '../../../src/repl/commands/handlers/status.js';
import { listCommand } from '../../../src/repl/commands/handlers/list.js';
import { runCommand } from '../../../src/repl/commands/handlers/run.js';
import { resumeCommand } from '../../../src/repl/commands/handlers/resume.js';
import { workspaceCommand } from '../../../src/repl/commands/handlers/workspace.js';
import { modelCommand } from '../../../src/repl/commands/handlers/model.js';
import { clearCommand } from '../../../src/repl/commands/handlers/clear.js';
import { historyCommand } from '../../../src/repl/commands/handlers/history.js';
import { registerAllCommands } from '../../../src/repl/commands/registerAll.js';

// Helpers ---------------------------------------------------------------------

function makeBaseCtx(overrides: Partial<ReplCtx> = {}): ReplCtx {
  return {
    workspace: 'internal',
    model: 'claude/claude-sonnet-4-6',
    ...overrides,
  };
}

function freshStore(): ReplStore {
  // Reset Zustand store state to defaults so each test starts clean.
  const s = useReplStore.getState();
  useReplStore.setState({
    session: {
      workspace: 'internal',
      activeModel: null,
      permissionMode: 'default',
      costSession: 0,
      setWorkspace: s.session.setWorkspace,
      setModel: s.session.setModel,
      cyclePermissionMode: s.session.cyclePermissionMode,
      addCost: s.session.addCost,
      resetSession: s.session.resetSession,
    },
    workflow: {
      activeWfIds: [],
      currentWfId: null,
      tasksByWfId: {},
      setCurrent: s.workflow.setCurrent,
      addWorkflow: s.workflow.addWorkflow,
      upsertTask: s.workflow.upsertTask,
      removeWorkflow: s.workflow.removeWorkflow,
    },
    gates: {
      pendingQueue: [],
      head: null,
      enqueueGate: s.gates.enqueueGate,
      resolveHead: s.gates.resolveHead,
      peekHead: s.gates.peekHead,
    },
    ui: {
      focusedPane: 'input',
      modalStack: [],
      modalProps: {},
      theme: 'dark',
      notifications: [],
      setFocus: s.ui.setFocus,
      pushModal: s.ui.pushModal,
      popModal: s.ui.popModal,
      getModalProps: s.ui.getModalProps,
      pushNotification: s.ui.pushNotification,
      dismissNotification: s.ui.dismissNotification,
    },
  });
  return useReplStore.getState();
}

function seedWorkflow(
  db: Database.Database,
  id: string,
  workspace: string,
  status: string,
  objective: string,
  createdAt = Date.now(),
): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, workspace, objective, status, createdAt);
}

function seedTask(
  db: Database.Database,
  taskId: string,
  wfId: string,
  name: string,
  kind: string,
  status: string,
  createdAt = Date.now(),
): void {
  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, wfId, name, kind, status, createdAt);
}

beforeEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
describe('/help handler', () => {
  it('without args lists categories and commands', async () => {
    registerAllCommands();
    const result = await helpCommand.handler({}, makeBaseCtx());
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('WORKFLOW');
    expect(result.output).toContain('/run');
    expect(result.output).toContain('/status');
  });

  it('with known command arg returns that command help text', async () => {
    registerAllCommands();
    const result = await helpCommand.handler({ command: 'run' }, makeBaseCtx());
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('run');
    expect(result.output).toContain('Arguments');
    expect(result.output).toContain('objective');
  });

  it('with unknown command arg returns Error', async () => {
    const result = await helpCommand.handler({ command: 'doesnotexist' }, makeBaseCtx());
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('doesnotexist');
  });
});

// ---------------------------------------------------------------------------
// /exit
// ---------------------------------------------------------------------------
describe('/exit handler', () => {
  it('returns exitCode 0', async () => {
    const result = await exitCommand.handler({}, makeBaseCtx());
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('declares quit alias', () => {
    expect(exitCommand.aliases).toContain('quit');
  });
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
describe('/status handler', () => {
  let db: Database.Database;
  beforeEach(() => { db = initDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('without db returns placeholder', async () => {
    const result = await statusCommand.handler({}, makeBaseCtx());
    expect(result.output).toContain('MA:');
  });

  it('without arg picks latest workflow in current workspace', async () => {
    seedWorkflow(db, 'wf_old',  'internal', 'completed', 'old goal',  Date.now() - 5000);
    seedWorkflow(db, 'wf_new',  'internal', 'executing', 'new goal',  Date.now());
    seedWorkflow(db, 'wf_other','client',   'completed', 'other ws',  Date.now() + 1000);

    const result = await statusCommand.handler({}, makeBaseCtx({ db }));
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('wf_new');
    expect(result.output).not.toContain('wf_other');
  });

  it('with explicit wf_id loads that workflow', async () => {
    seedWorkflow(db, 'wf_x', 'internal', 'completed', 'objective x');
    seedTask(db, 'tk_1', 'wf_x', 'plan', 'llm_call', 'completed');

    const result = await statusCommand.handler({ workflow_id: 'wf_x' }, makeBaseCtx({ db }));
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('wf_x');
    expect(result.output).toContain('plan');
  });

  it('with unknown wf_id returns not-found message (not an error)', async () => {
    const result = await statusCommand.handler({ workflow_id: 'wf_zzz' }, makeBaseCtx({ db }));
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// /list
// ---------------------------------------------------------------------------
describe('/list handler', () => {
  let db: Database.Database;
  beforeEach(() => { db = initDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('without db returns placeholder', async () => {
    const result = await listCommand.handler({}, makeBaseCtx());
    expect(result.output).toContain('MA:');
  });

  it('returns no-workflows message when DB is empty', async () => {
    const result = await listCommand.handler({}, makeBaseCtx({ db }));
    expect(result.output).toContain('No workflows');
  });

  it('lists workflows ordered by created_at desc', async () => {
    seedWorkflow(db, 'wf_a', 'internal', 'completed', 'first',  Date.now() - 2000);
    seedWorkflow(db, 'wf_b', 'internal', 'failed',    'second', Date.now() - 1000);
    seedWorkflow(db, 'wf_c', 'internal', 'executing', 'third',  Date.now());

    const result = await listCommand.handler({}, makeBaseCtx({ db }));
    expect(result.output).toContain('wf_a');
    expect(result.output).toContain('wf_b');
    expect(result.output).toContain('wf_c');
    // newest first
    const idxC = result.output!.indexOf('wf_c');
    const idxA = result.output!.indexOf('wf_a');
    expect(idxC).toBeLessThan(idxA);
  });

  it('filters by status', async () => {
    seedWorkflow(db, 'wf_p', 'internal', 'completed', 'pass');
    seedWorkflow(db, 'wf_f', 'internal', 'failed',    'fail');
    const result = await listCommand.handler({ status: 'failed' }, makeBaseCtx({ db }));
    expect(result.output).toContain('wf_f');
    expect(result.output).not.toContain('wf_p');
  });

  it('filters by workspace and respects limit', async () => {
    seedWorkflow(db, 'wf_x1', 'internal', 'completed', 'a');
    seedWorkflow(db, 'wf_x2', 'client',   'completed', 'b');
    const result = await listCommand.handler(
      { workspace: 'client', limit: 5 },
      makeBaseCtx({ db }),
    );
    expect(result.output).toContain('wf_x2');
    expect(result.output).not.toContain('wf_x1');
  });
});

// ---------------------------------------------------------------------------
// /run
// ---------------------------------------------------------------------------
describe('/run handler', () => {
  // The handler now kicks runWorkflow ASYNC and returns immediately. The kickoff
  // line goes to the outputBuffer (verified separately in runner tests once the
  // SSE-mock infra lands). Here we cover the validation surface + the
  // workflow.start_requested event payload, which is deterministic.

  it('rejects empty objective with helpful Error', async () => {
    const result = await runCommand.handler({ objective: '' }, makeBaseCtx());
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('Missing objective');
  });

  it('rejects whitespace-only objective', async () => {
    const result = await runCommand.handler({ objective: '   \n  ' }, makeBaseCtx());
    expect(result.error).toBeInstanceOf(Error);
  });

  it('emits workflow.start_requested event with objective + workspace', async () => {
    const result = await runCommand.handler(
      { objective: 'build a TODO app' },
      makeBaseCtx(),
    );
    expect(result.error).toBeUndefined();
    expect(result.events?.[0]?.type).toBe('workflow.start_requested');
    const payload = result.events?.[0]?.payload as { workspace?: string; objective?: string };
    expect(payload.objective).toBe('build a TODO app');
    expect(payload.workspace).toBe('internal');
  });

  it('overrides workspace when provided', async () => {
    const result = await runCommand.handler(
      { objective: 'deploy', workspace: 'prod' },
      makeBaseCtx(),
    );
    const payload = result.events?.[0]?.payload as { workspace?: string };
    expect(payload.workspace).toBe('prod');
  });
});

// ---------------------------------------------------------------------------
// /resume
// ---------------------------------------------------------------------------
describe('/resume handler', () => {
  let db: Database.Database;
  beforeEach(() => { db = initDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('without db returns placeholder mentioning the wf id', async () => {
    // Wave 2 W2-D replaced the "TODO MC" comment with a clearer fallback message.
    const result = await resumeCommand.handler({ wf_id: 'wf_abc' }, makeBaseCtx());
    expect(result.output).toContain('wf_abc');
    expect(result.output).toContain('Resume request received');
  });

  it('with unknown wf_id returns Error', async () => {
    const result = await resumeCommand.handler(
      { wf_id: 'wf_missing' },
      makeBaseCtx({ db }),
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('wf_missing');
  });
});

// ---------------------------------------------------------------------------
// /workspace
// ---------------------------------------------------------------------------
describe('/workspace handler', () => {
  it('without arg returns current workspace from ctx (no store)', async () => {
    const result = await workspaceCommand.handler({}, makeBaseCtx());
    expect(result.output).toContain('internal');
  });

  it('without arg prefers store workspace when present', async () => {
    const store = freshStore();
    store.session.setWorkspace('staging');
    const result = await workspaceCommand.handler({}, makeBaseCtx({ store: useReplStore.getState() }));
    expect(result.output).toContain('staging');
  });

  it('with valid name updates session store and emits event', async () => {
    freshStore();
    const result = await workspaceCommand.handler(
      { name: 'prod' },
      makeBaseCtx({ store: useReplStore.getState() }),
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('prod');
    expect(result.events?.[0]?.type).toBe('workspace.changed');
    expect(useReplStore.getState().session.workspace).toBe('prod');
  });

  it('rejects invalid name with path traversal', async () => {
    const result = await workspaceCommand.handler({ name: '../etc' }, makeBaseCtx());
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('Invalid workspace name');
  });

  it('rejects names with whitespace', async () => {
    const result = await workspaceCommand.handler({ name: 'has space' }, makeBaseCtx());
    expect(result.error).toBeInstanceOf(Error);
  });

  it('accepts valid names with hyphens and underscores', async () => {
    freshStore();
    const result = await workspaceCommand.handler(
      { name: 'my-workspace_42' },
      makeBaseCtx({ store: useReplStore.getState() }),
    );
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------
describe('/model handler', () => {
  // The handler now opens an interactive cascade picker when called bare;
  // tests cover the shortcut form (/model <target> [<model_id>]) which is
  // the deterministic, scriptable surface.

  it('/model show prints current configuration for all 4 targets', async () => {
    freshStore();
    const result = await modelCommand.handler(
      { target: 'show' },
      makeBaseCtx({ store: useReplStore.getState() }),
    );
    expect(result.output).toContain('DECOMPOSER');
    expect(result.output).toContain('TASK');
    expect(result.output).toContain('REVIEWER');
    expect(result.output).toContain('CONSOLIDATOR');
  });

  it('/model task <id> sets process.env.TASK_MODEL', async () => {
    freshStore();
    const before = process.env['TASK_MODEL'];
    try {
      const result = await modelCommand.handler(
        { target: 'task', model_id: 'claude/claude-opus-4-6' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(result.error).toBeUndefined();
      expect(result.events?.[0]?.type).toBe('model.set');
      expect(process.env['TASK_MODEL']).toBe('claude/claude-opus-4-6');
    } finally {
      if (before === undefined) delete process.env['TASK_MODEL'];
      else process.env['TASK_MODEL'] = before;
    }
  });

  it('/model all <id> sets all 4 env vars', async () => {
    freshStore();
    const keys = ['DECOMPOSER_MODEL', 'TASK_MODEL', 'REVIEWER_MODEL', 'CONSOLIDATOR_MODEL'] as const;
    const snapshot = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      const result = await modelCommand.handler(
        { target: 'all', model_id: 'cc/claude-haiku-4-5-20251001' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(result.error).toBeUndefined();
      expect(result.events?.[0]?.type).toBe('model.set_all');
      for (const k of keys) {
        expect(process.env[k]).toBe('cc/claude-haiku-4-5-20251001');
      }
    } finally {
      for (const k of keys) {
        const v = snapshot[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('/model reset restores defaults', async () => {
    freshStore();
    const keys = ['DECOMPOSER_MODEL', 'TASK_MODEL', 'REVIEWER_MODEL', 'CONSOLIDATOR_MODEL'] as const;
    const snapshot = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      // Set to non-defaults first
      process.env['TASK_MODEL'] = 'whatever/whatever';
      const result = await modelCommand.handler(
        { target: 'reset' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(result.error).toBeUndefined();
      expect(result.events?.[0]?.type).toBe('model.reset');
      expect(process.env['TASK_MODEL']).toBe('claude/claude-sonnet-4-6');
      expect(process.env['DECOMPOSER_MODEL']).toBe('claude/claude-opus-4-6');
    } finally {
      for (const k of keys) {
        const v = snapshot[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('rejects unknown target', async () => {
    const result = await modelCommand.handler(
      { target: 'unknown_target', model_id: 'claude/claude-sonnet-4-6' },
      makeBaseCtx(),
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('Unknown target');
  });

  it('rejects malformed model id with valid target', async () => {
    const result = await modelCommand.handler(
      { target: 'task', model_id: 'no-separator-here' },
      makeBaseCtx(),
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain('Invalid model id');
  });

  it('bare /model with store opens picker (returns empty output)', async () => {
    const store = freshStore();
    const ctx = makeBaseCtx({ store: useReplStore.getState() });
    const result = await modelCommand.handler({}, ctx);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('');
    expect(useReplStore.getState().ui.modalStack).toContain('model-picker');
  });

  it('bare /model without store falls back to text printout', async () => {
    const result = await modelCommand.handler({}, makeBaseCtx());
    expect(result.output).toContain('Current configuration');
  });

  it('/model task cli:cursor sets TASK_EXECUTOR (not TASK_MODEL)', async () => {
    freshStore();
    const beforeModel = process.env['TASK_MODEL'];
    const beforeExec = process.env['TASK_EXECUTOR'];
    // Start clean so the assertion that TASK_MODEL was untouched is meaningful.
    delete process.env['TASK_MODEL'];
    delete process.env['TASK_EXECUTOR'];
    try {
      const result = await modelCommand.handler(
        { target: 'task', model_id: 'cli:cursor' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('executor');
      expect(process.env['TASK_EXECUTOR']).toBe('cli:cursor');
      expect(process.env['TASK_MODEL']).toBeUndefined();
      expect(result.events?.[0]?.payload).toMatchObject({ lane: 'executor' });
    } finally {
      if (beforeModel === undefined) delete process.env['TASK_MODEL'];
      else process.env['TASK_MODEL'] = beforeModel;
      if (beforeExec === undefined) delete process.env['TASK_EXECUTOR'];
      else process.env['TASK_EXECUTOR'] = beforeExec;
    }
  });

  it('/model all cli:opencode sets all 4 EXECUTOR env vars', async () => {
    freshStore();
    const execKeys = [
      'DECOMPOSER_EXECUTOR',
      'TASK_EXECUTOR',
      'REVIEWER_EXECUTOR',
      'CONSOLIDATOR_EXECUTOR',
    ] as const;
    const snapshot = Object.fromEntries(execKeys.map((k) => [k, process.env[k]]));
    for (const k of execKeys) delete process.env[k];
    try {
      const result = await modelCommand.handler(
        { target: 'all', model_id: 'cli:opencode' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(result.error).toBeUndefined();
      for (const k of execKeys) {
        expect(process.env[k]).toBe('cli:opencode');
      }
      expect(result.events?.[0]?.payload).toMatchObject({ lane: 'executor' });
    } finally {
      for (const k of execKeys) {
        const v = snapshot[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('/model reset clears both MODEL defaults AND EXECUTOR overrides', async () => {
    freshStore();
    const beforeExec = process.env['TASK_EXECUTOR'];
    const beforeModel = process.env['TASK_MODEL'];
    // Seed both lanes
    process.env['TASK_EXECUTOR'] = 'cli:cursor';
    process.env['TASK_MODEL'] = 'custom/model';
    try {
      await modelCommand.handler(
        { target: 'reset' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(process.env['TASK_EXECUTOR']).toBeUndefined();
      expect(process.env['TASK_MODEL']).toBe('claude/claude-sonnet-4-6');
    } finally {
      if (beforeExec === undefined) delete process.env['TASK_EXECUTOR'];
      else process.env['TASK_EXECUTOR'] = beforeExec;
      if (beforeModel === undefined) delete process.env['TASK_MODEL'];
      else process.env['TASK_MODEL'] = beforeModel;
    }
  });

  it('/model show displays both model AND executor lanes per target', async () => {
    freshStore();
    const beforeExec = process.env['TASK_EXECUTOR'];
    process.env['TASK_EXECUTOR'] = 'cli:opencode';
    try {
      const result = await modelCommand.handler(
        { target: 'show' },
        makeBaseCtx({ store: useReplStore.getState() }),
      );
      expect(result.output).toContain('model=');
      expect(result.output).toContain('exec=cli:opencode');
    } finally {
      if (beforeExec === undefined) delete process.env['TASK_EXECUTOR'];
      else process.env['TASK_EXECUTOR'] = beforeExec;
    }
  });
});

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------
describe('/clear handler', () => {
  beforeEach(() => { resetOutputBuffer(); });

  it('emits output_cleared event', async () => {
    const result = await clearCommand.handler({}, makeBaseCtx());
    expect(result.events?.[0]?.type).toBe('output_cleared');
  });

  it('actually drains the output buffer', async () => {
    appendOutput('line1');
    appendOutput('line2');
    expect(getOutputSnapshot().length).toBe(2);

    await clearCommand.handler({}, makeBaseCtx());
    expect(getOutputSnapshot().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /history
// ---------------------------------------------------------------------------
describe('/history handler', () => {
  it('returns no-history message when workspace has no file', async () => {
    // Use a workspace name that won't have a real .repl-history file.
    const ctx = makeBaseCtx({ workspace: 'this-workspace-has-no-history-file-zzz' });
    const result = await historyCommand.handler({}, ctx);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('No history');
  });

  it('honours custom limit (caps at MAX_LIMIT)', async () => {
    const ctx = makeBaseCtx({ workspace: 'this-workspace-has-no-history-file-zzz' });
    const result = await historyCommand.handler({ limit: 5 }, ctx);
    expect(result.error).toBeUndefined();
  });
});
