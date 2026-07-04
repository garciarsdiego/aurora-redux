import type Database from 'better-sqlite3';
import {
  createContextMessage,
  ensureRunContextChannel,
  ensureTaskContextThread,
  listDependencyHandoffs,
  saveContextPacket,
  saveTaskHandoff,
  type ContextThreadRow,
} from './store.js';
import type { ContextPacketRow, TaskHandoffRow } from './store.js';
import type { TaskHandoffKind } from './types.js';
import { redactContextJson, redactContextText } from './redaction.js';

export interface EnsureWorkflowContextInput {
  workspace: string;
  runId: string;
  objective: string;
}

export interface RecordTaskThreadEventInput {
  workspace: string;
  runId: string;
  taskId: string;
  taskName: string;
  eventType: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface RecordTaskContextPacketInput {
  workspace: string;
  runId: string;
  taskId: string;
  taskName: string;
  attempt: number;
  dependsOn?: string[];
  packet: Record<string, unknown>;
  renderedPrompt?: string;
}

export interface RecordTaskHandoffInput {
  workspace: string;
  runId: string;
  taskId: string;
  taskName: string;
  attempt: number;
  kind: TaskHandoffKind;
  title?: string;
  body: string;
  artifacts?: string[];
  filesTouched?: string[];
  decisions?: string[];
  safeContext?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const MAX_CONTEXT_TEXT_CHARS = 16_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CONTEXT_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CONTEXT_TEXT_CHARS), truncated: true };
}

function safeRenderedPrompt(packet: Record<string, unknown>, renderedPrompt?: string): string {
  if (typeof renderedPrompt === 'string' && renderedPrompt.trim()) {
    return truncateText(redactContextText(renderedPrompt)).text;
  }
  return truncateText(JSON.stringify(redactContextJson(packet))).text;
}

export function ensureWorkflowContext(
  db: Database.Database,
  input: EnsureWorkflowContextInput,
) {
  return ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
    metadata: { objective: input.objective },
  });
}

export function recordTaskThreadEvent(
  db: Database.Database,
  input: RecordTaskThreadEventInput,
): ContextThreadRow {
  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = ensureTaskContextThread(db, {
    channelId: channel.id,
    runId: input.runId,
    taskId: input.taskId,
    title: input.taskName,
  });
  createContextMessage(db, {
    threadId: thread.id,
    senderType: 'system',
    senderId: 'workflow',
    kind: 'event',
    body: input.body,
    metadata: { eventType: input.eventType, ...(input.metadata ?? {}) },
  });
  return thread;
}

export function recordTaskContextPacket(
  db: Database.Database,
  input: RecordTaskContextPacketInput,
): ContextPacketRow {
  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = ensureTaskContextThread(db, {
    channelId: channel.id,
    runId: input.runId,
    taskId: input.taskId,
    title: input.taskName,
  });
  const dependencyHandoffs = listDependencyHandoffs(db, input.runId, input.dependsOn ?? []);
  const rendered = safeRenderedPrompt(input.packet, input.renderedPrompt);
  const packet = saveContextPacket(db, {
    runId: input.runId,
    taskId: input.taskId,
    attempt: input.attempt,
    threadId: thread.id,
    packet: input.packet,
    renderedPrompt: rendered,
    includedHandoffs: dependencyHandoffs.map((handoff) => ({
      handoffId: handoff.id,
      taskId: handoff.task_id,
      chars: handoff.body.length,
    })),
    excludedItems: [],
    tokenEstimate: estimateTokens(rendered),
    truncated: rendered.length >= MAX_CONTEXT_TEXT_CHARS,
  });
  createContextMessage(db, {
    threadId: thread.id,
    senderType: 'system',
    senderId: 'workflow',
    kind: 'context_packet',
    body: `Context packet captured for attempt ${input.attempt}.`,
    metadata: {
      eventType: 'context_packet_captured',
      context_packet_id: packet.id,
      included_handoffs: dependencyHandoffs.length,
      truncated: packet.truncated === 1,
    },
  });
  return packet;
}

export function recordTaskHandoff(
  db: Database.Database,
  input: RecordTaskHandoffInput,
): TaskHandoffRow {
  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = ensureTaskContextThread(db, {
    channelId: channel.id,
    runId: input.runId,
    taskId: input.taskId,
    title: input.taskName,
  });
  const body = truncateText(input.body);
  const handoff = saveTaskHandoff(db, {
    runId: input.runId,
    taskId: input.taskId,
    attempt: input.attempt,
    threadId: thread.id,
    kind: input.kind,
    title: input.title ?? `${input.taskName} handoff`,
    body: body.text,
    artifacts: input.artifacts ?? [],
    filesTouched: input.filesTouched ?? [],
    decisions: input.decisions ?? [],
    safeContext: input.safeContext ?? {},
    tokenEstimate: estimateTokens(body.text),
    truncated: body.truncated,
  });
  createContextMessage(db, {
    threadId: thread.id,
    senderType: input.kind === 'error' ? 'system' : 'agent',
    senderId: input.kind === 'error' ? 'workflow' : input.taskId,
    kind: input.kind === 'error' ? 'error' : 'handoff',
    body: body.text,
    metadata: {
      eventType: 'task_handoff_recorded',
      handoff_id: handoff.id,
      handoff_kind: input.kind,
      truncated: body.truncated,
      ...(input.metadata ?? {}),
    },
  });
  return handoff;
}

export function safeEnsureWorkflowContext(
  db: Database.Database,
  input: EnsureWorkflowContextInput,
): void {
  try {
    ensureWorkflowContext(db, input);
  } catch {
    // Context orchestration must never block workflow execution.
  }
}

export function safeRecordTaskThreadEvent(
  db: Database.Database,
  input: RecordTaskThreadEventInput,
): void {
  try {
    recordTaskThreadEvent(db, input);
  } catch {
    // Context orchestration must never block workflow execution.
  }
}

export function safeRecordTaskContextPacket(
  db: Database.Database,
  input: RecordTaskContextPacketInput,
): void {
  try {
    recordTaskContextPacket(db, input);
  } catch {
    // Context orchestration must never block workflow execution.
  }
}

export function safeRecordTaskHandoff(
  db: Database.Database,
  input: RecordTaskHandoffInput,
): void {
  try {
    recordTaskHandoff(db, input);
  } catch {
    // Context orchestration must never block workflow execution.
  }
}
