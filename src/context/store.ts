import type Database from 'better-sqlite3';
import type {
  ContextChannelKind,
  ContextDecisionKind,
  ContextDecisionStatus,
  ContextMessageKind,
  ContextPacketInput,
  ContextSenderType,
  ContextThreadKind,
  ContextThreadStatus,
  TaskHandoffInput,
  WorkItemKind,
  WorkItemStatus,
} from './types.js';
import { redactContextBody, redactContextJson, redactContextText } from './redaction.js';

export interface ContextChannelRow {
  id: string;
  workspace: string;
  kind: ContextChannelKind;
  name: string;
  title: string;
  project_id: string | null;
  run_id: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface ContextThreadRow {
  id: string;
  channel_id: string;
  kind: ContextThreadKind;
  title: string;
  project_id: string | null;
  work_item_id: string | null;
  run_id: string | null;
  task_id: string | null;
  artifact_id: string | null;
  status: ContextThreadStatus;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface ContextMessageRow {
  id: string;
  thread_id: string;
  seq: number;
  sender_type: ContextSenderType;
  sender_id: string;
  kind: ContextMessageKind;
  body: string;
  metadata_json: string;
  created_at: number;
}

export interface ContextPacketRow {
  id: string;
  run_id: string;
  task_id: string;
  attempt: number;
  thread_id: string | null;
  packet_json: string;
  rendered_prompt: string;
  included_handoffs_json: string;
  excluded_items_json: string;
  token_estimate: number;
  truncated: number;
  created_at: number;
}

export interface TaskHandoffRow {
  id: string;
  run_id: string;
  task_id: string;
  attempt: number;
  thread_id: string | null;
  kind: TaskHandoffInput['kind'];
  title: string;
  body: string;
  artifacts_json: string;
  files_touched_json: string;
  decisions_json: string;
  safe_context_json: string;
  token_estimate: number;
  truncated: number;
  created_at: number;
}

export interface WorkItemRow {
  id: string;
  parent_id: string | null;
  workspace: string;
  kind: WorkItemKind;
  title: string;
  objective: string;
  status: WorkItemStatus;
  run_id: string | null;
  task_id: string | null;
  order_index: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface ContextDecisionRow {
  id: string;
  thread_id: string | null;
  run_id: string | null;
  task_id: string | null;
  kind: ContextDecisionKind;
  status: ContextDecisionStatus;
  rationale: string;
  metadata_json: string;
  created_at: number;
}

export interface CreateContextChannelInput {
  workspace: string;
  kind: ContextChannelKind;
  name: string;
  title: string;
  projectId?: string | null;
  runId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateContextThreadInput {
  channelId: string;
  kind: ContextThreadKind;
  title: string;
  projectId?: string | null;
  workItemId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  artifactId?: string | null;
  status?: ContextThreadStatus;
  metadata?: Record<string, unknown>;
}

export interface CreateContextMessageInput {
  threadId: string;
  senderType: ContextSenderType;
  senderId: string;
  kind: ContextMessageKind;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface CreateWorkItemInput {
  workspace: string;
  kind: WorkItemKind;
  title: string;
  objective?: string;
  parentId?: string | null;
  status?: WorkItemStatus;
  runId?: string | null;
  taskId?: string | null;
  orderIndex?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordContextDecisionInput {
  threadId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  kind: ContextDecisionKind;
  status?: ContextDecisionStatus;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

function newContextId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactContextJson(value ?? {}));
}

function isContextMessageSeqConflict(err: unknown): boolean {
  return err instanceof Error &&
    err.message.includes('UNIQUE constraint failed') &&
    err.message.includes('context_messages.thread_id') &&
    err.message.includes('context_messages.seq');
}

export function createContextChannel(
  db: Database.Database,
  input: CreateContextChannelInput,
): ContextChannelRow {
  const now = Date.now();
  const workspace = requiredString(input.workspace, 'workspace');
  const name = requiredString(input.name, 'name');
  const title = redactContextText(requiredString(input.title, 'title'));
  const existing = db
    .prepare(`SELECT * FROM context_channels WHERE workspace = ? AND name = ?`)
    .get(workspace, name) as ContextChannelRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE context_channels
          SET kind = ?,
              title = ?,
              project_id = ?,
              run_id = ?,
              metadata_json = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      input.kind,
      title,
      optionalString(input.projectId),
      optionalString(input.runId),
      safeJson(input.metadata ?? {}),
      now,
      existing.id,
    );
    return loadContextChannel(db, existing.id)!;
  }

  const id = newContextId('ch');
  db.prepare(
    `INSERT INTO context_channels
       (id, workspace, kind, name, title, project_id, run_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspace,
    input.kind,
    name,
    title,
    optionalString(input.projectId),
    optionalString(input.runId),
    safeJson(input.metadata ?? {}),
    now,
    now,
  );
  return loadContextChannel(db, id)!;
}

export function ensureRunContextChannel(
  db: Database.Database,
  input: { workspace: string; runId: string; title?: string; metadata?: Record<string, unknown> },
): ContextChannelRow {
  return createContextChannel(db, {
    workspace: input.workspace,
    kind: 'run',
    name: `run:${requiredString(input.runId, 'runId')}`,
    title: input.title ?? `Run ${input.runId}`,
    runId: input.runId,
    metadata: input.metadata,
  });
}

export function loadContextChannel(db: Database.Database, id: string): ContextChannelRow | null {
  const row = db.prepare(`SELECT * FROM context_channels WHERE id = ?`).get(id) as ContextChannelRow | undefined;
  return row ?? null;
}

export function createContextThread(
  db: Database.Database,
  input: CreateContextThreadInput,
): ContextThreadRow {
  const now = Date.now();
  const id = newContextId('th');
  db.prepare(
    `INSERT INTO context_threads
       (id, channel_id, kind, title, project_id, work_item_id, run_id, task_id,
        artifact_id, status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    requiredString(input.channelId, 'channelId'),
    input.kind,
    redactContextText(requiredString(input.title, 'title')),
    optionalString(input.projectId),
    optionalString(input.workItemId),
    optionalString(input.runId),
    optionalString(input.taskId),
    optionalString(input.artifactId),
    input.status ?? 'open',
    safeJson(input.metadata ?? {}),
    now,
    now,
  );
  return loadContextThread(db, id)!;
}

export function ensureTaskContextThread(
  db: Database.Database,
  input: { channelId: string; runId: string; taskId: string; title: string; metadata?: Record<string, unknown> },
): ContextThreadRow {
  const existing = db
    .prepare(
      `SELECT * FROM context_threads
        WHERE channel_id = ? AND run_id = ? AND task_id = ? AND kind = 'task'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(input.channelId, input.runId, input.taskId) as ContextThreadRow | undefined;
  if (existing) return existing;
  return createContextThread(db, {
    channelId: input.channelId,
    kind: 'task',
    title: input.title,
    runId: input.runId,
    taskId: input.taskId,
    metadata: input.metadata,
  });
}

export function loadContextThread(db: Database.Database, id: string): ContextThreadRow | null {
  const row = db.prepare(`SELECT * FROM context_threads WHERE id = ?`).get(id) as ContextThreadRow | undefined;
  return row ?? null;
}

export function listThreadsForRun(db: Database.Database, runId: string): ContextThreadRow[] {
  return db
    .prepare(`SELECT * FROM context_threads WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
    .all(runId) as ContextThreadRow[];
}

export function createContextMessage(
  db: Database.Database,
  input: CreateContextMessageInput,
): ContextMessageRow {
  const now = Date.now();
  const id = newContextId('msg');
  const threadId = requiredString(input.threadId, 'threadId');
  const senderId = requiredString(input.senderId, 'senderId');
  const body = redactContextBody(input.body);
  const metadataJson = safeJson(input.metadata ?? {});

  const insert = db.transaction(() => {
    const current = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM context_messages WHERE thread_id = ?`)
      .get(threadId) as { seq: number };
    const seq = current.seq + 1;
    db.prepare(
      `INSERT INTO context_messages
         (id, thread_id, seq, sender_type, sender_id, kind, body, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      threadId,
      seq,
      input.senderType,
      senderId,
      input.kind,
      body,
      metadataJson,
      now,
    );
  });

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      insert();
      return loadContextMessage(db, id)!;
    } catch (err) {
      if (attempt === 4 || !isContextMessageSeqConflict(err)) throw err;
    }
  }
  return loadContextMessage(db, id)!;
}

export function loadContextMessage(db: Database.Database, id: string): ContextMessageRow | null {
  const row = db.prepare(`SELECT * FROM context_messages WHERE id = ?`).get(id) as ContextMessageRow | undefined;
  return row ?? null;
}

export function loadThreadMessages(db: Database.Database, threadId: string): ContextMessageRow[] {
  return db
    .prepare(`SELECT * FROM context_messages WHERE thread_id = ? ORDER BY seq ASC`)
    .all(threadId) as ContextMessageRow[];
}

export function saveContextPacket(
  db: Database.Database,
  input: ContextPacketInput,
): ContextPacketRow {
  const id = newContextId('cp');
  const now = Date.now();
  db.prepare(
    `INSERT INTO context_packets
       (id, run_id, task_id, attempt, thread_id, packet_json, rendered_prompt,
        included_handoffs_json, excluded_items_json, token_estimate, truncated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, task_id, attempt) DO UPDATE SET
       thread_id = excluded.thread_id,
       packet_json = excluded.packet_json,
       rendered_prompt = excluded.rendered_prompt,
       included_handoffs_json = excluded.included_handoffs_json,
       excluded_items_json = excluded.excluded_items_json,
       token_estimate = excluded.token_estimate,
       truncated = excluded.truncated`,
  ).run(
    id,
    requiredString(input.runId, 'runId'),
    requiredString(input.taskId, 'taskId'),
    input.attempt,
    optionalString(input.threadId),
    safeJson(input.packet),
    redactContextBody(input.renderedPrompt),
    safeJson(input.includedHandoffs),
    safeJson(input.excludedItems),
    input.tokenEstimate,
    input.truncated ? 1 : 0,
    now,
  );
  return loadContextPacketForAttempt(db, input.taskId, input.attempt, input.runId)!;
}

export function loadContextPacketForAttempt(
  db: Database.Database,
  taskId: string,
  attempt: number,
  runId?: string,
): ContextPacketRow | null {
  if (runId) {
    const row = db
      .prepare(`SELECT * FROM context_packets WHERE run_id = ? AND task_id = ? AND attempt = ?`)
      .get(runId, taskId, attempt) as ContextPacketRow | undefined;
    return row ?? null;
  }
  const row = db
    .prepare(`SELECT * FROM context_packets WHERE task_id = ? AND attempt = ?`)
    .get(taskId, attempt) as ContextPacketRow | undefined;
  return row ?? null;
}

export function saveTaskHandoff(
  db: Database.Database,
  input: TaskHandoffInput,
): TaskHandoffRow {
  const id = newContextId('ho');
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_handoffs
       (id, run_id, task_id, attempt, thread_id, kind, title, body, artifacts_json,
        files_touched_json, decisions_json, safe_context_json, token_estimate, truncated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    requiredString(input.runId, 'runId'),
    requiredString(input.taskId, 'taskId'),
    input.attempt,
    optionalString(input.threadId),
    input.kind,
    redactContextText(requiredString(input.title, 'title')),
    redactContextBody(input.body),
    safeJson(input.artifacts),
    safeJson(input.filesTouched),
    safeJson(input.decisions),
    safeJson(input.safeContext),
    input.tokenEstimate,
    input.truncated ? 1 : 0,
    now,
  );
  return loadTaskHandoff(db, id)!;
}

export function loadTaskHandoff(db: Database.Database, id: string): TaskHandoffRow | null {
  const row = db.prepare(`SELECT * FROM task_handoffs WHERE id = ?`).get(id) as TaskHandoffRow | undefined;
  return row ?? null;
}

export function listTaskHandoffsForRun(db: Database.Database, runId: string): TaskHandoffRow[] {
  return db
    .prepare(`SELECT * FROM task_handoffs WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
    .all(runId) as TaskHandoffRow[];
}

export function listDependencyHandoffs(db: Database.Database, runId: string, taskIds: string[]): TaskHandoffRow[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM task_handoffs
        WHERE run_id = ? AND task_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    )
    .all(runId, ...taskIds) as TaskHandoffRow[];
}

export function createWorkItem(db: Database.Database, input: CreateWorkItemInput): WorkItemRow {
  const id = newContextId('wi');
  const now = Date.now();
  db.prepare(
    `INSERT INTO work_items
       (id, parent_id, workspace, kind, title, objective, status, run_id, task_id,
        order_index, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    optionalString(input.parentId),
    requiredString(input.workspace, 'workspace'),
    input.kind,
    redactContextText(requiredString(input.title, 'title')),
    redactContextText(input.objective ?? ''),
    input.status ?? 'planned',
    optionalString(input.runId),
    optionalString(input.taskId),
    input.orderIndex ?? 0,
    safeJson(input.metadata ?? {}),
    now,
    now,
  );
  return loadWorkItem(db, id)!;
}

export function loadWorkItem(db: Database.Database, id: string): WorkItemRow | null {
  const row = db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as WorkItemRow | undefined;
  return row ?? null;
}

export function listWorkItemTree(db: Database.Database, rootId: string): WorkItemRow[] {
  return db
    .prepare(
      `WITH RECURSIVE tree AS (
         SELECT * FROM work_items WHERE id = ?
         UNION ALL
         SELECT child.* FROM work_items child
         JOIN tree parent ON child.parent_id = parent.id
       )
       SELECT * FROM tree ORDER BY parent_id IS NOT NULL, parent_id, order_index, created_at`,
    )
    .all(rootId) as WorkItemRow[];
}

export function recordContextDecision(
  db: Database.Database,
  input: RecordContextDecisionInput,
): ContextDecisionRow {
  const id = newContextId('dec');
  const now = Date.now();
  db.prepare(
    `INSERT INTO context_decisions
       (id, thread_id, run_id, task_id, kind, status, rationale, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    optionalString(input.threadId),
    optionalString(input.runId),
    optionalString(input.taskId),
    input.kind,
    input.status ?? 'recorded',
    redactContextBody(input.rationale ?? ''),
    safeJson(input.metadata ?? {}),
    now,
  );
  return loadContextDecision(db, id)!;
}

export function loadContextDecision(db: Database.Database, id: string): ContextDecisionRow | null {
  const row = db.prepare(`SELECT * FROM context_decisions WHERE id = ?`).get(id) as ContextDecisionRow | undefined;
  return row ?? null;
}
