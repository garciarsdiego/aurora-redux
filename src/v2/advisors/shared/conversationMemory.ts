// src/v2/advisors/shared/conversationMemory.ts
// In-process conversation memory for stepwise advisor loops (AETHER γ).
// Keyed by conversationId; scoped to process lifetime.
// Persistence to SQLite is handled separately by src/db/persist.ts.
//
// Memory bounded by FIFO eviction (Map preserves insertion order). Default
// cap of 200 conversations chosen against stepwise advisor load: each entry
// is bounded by the per-step history length plus the seed metadata, and 200
// covers the longest dogfooding sessions observed without retaining lifetime
// telemetry. Override via ADVISOR_CONVERSATION_CACHE_SIZE for special runs
// (e.g. dataset replay). Entries are also dropped explicitly on
// completeConversation() so the DB cleanup path frees in-process state too.

import { randomBytes } from 'node:crypto';

export interface StepHistory {
  step: number;
  output: string;
  recordedAt: number;
}

interface ConversationRecord {
  conversationId: string;
  advisorName: string;
  workspaceId: string;
  taskId?: string;
  startedAt: number;
  history: StepHistory[];
}

const DEFAULT_CACHE_SIZE = 200;

function getMaxCacheSize(): number {
  const raw = process.env.ADVISOR_CONVERSATION_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_SIZE;
  return parsed;
}

// Single shared in-memory store for the process lifetime.
const store = new Map<string, ConversationRecord>();

/**
 * Evicts the oldest entries (FIFO, by insertion order) until store.size <= cap.
 * Map iteration order is insertion order, so first() = oldest.
 */
function evictIfNeeded(): void {
  const cap = getMaxCacheSize();
  while (store.size > cap) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) return;
    store.delete(oldestKey);
  }
}

/**
 * Creates a new conversation and returns its unique ID.
 * @param advisorName  Name of the advisor (e.g. "consensus", "codereview")
 * @param workspaceId  Omniforge workspace identifier
 * @param taskId       Optional task ID to associate with the conversation
 */
export function createConversation(
  advisorName: string,
  workspaceId: string,
  taskId?: string,
): string {
  const conversationId = randomBytes(8).toString('hex');
  ensureConversation(conversationId, advisorName, workspaceId, taskId);
  return conversationId;
}

/** Seeds in-memory history for an executor-supplied conversation id (e.g. SQLite `advisor_conversations.id`). */
export function ensureConversation(
  conversationId: string,
  advisorName: string,
  workspaceId: string,
  taskId?: string,
): void {
  if (store.has(conversationId)) return;
  store.set(conversationId, {
    conversationId,
    advisorName,
    workspaceId,
    taskId,
    startedAt: Date.now(),
    history: [],
  });
  evictIfNeeded();
}

/**
 * Appends a completed step's output to the conversation history.
 * Throws if conversationId is unknown.
 */
export function appendStep(conversationId: string, step: number, output: string): void {
  const record = store.get(conversationId);
  if (!record) {
    throw new Error(`conversationMemory: unknown conversationId "${conversationId}"`);
  }
  record.history.push({ step, output, recordedAt: Date.now() });
}

/**
 * Returns the full step history for a conversation, in step order.
 * Returns an empty array if conversationId is unknown.
 */
export function getHistory(conversationId: string): StepHistory[] {
  return store.get(conversationId)?.history ?? [];
}

/**
 * Returns all active conversationIds associated with a given taskId.
 */
export function getActiveConversations(taskId: string): string[] {
  const result: string[] = [];
  for (const record of store.values()) {
    if (record.taskId === taskId) {
      result.push(record.conversationId);
    }
  }
  return result;
}

/**
 * Removes a conversation from the in-memory store. Called from advisor
 * dispatchers after `db.persist.completeAdvisorConversation()` writes the
 * SQLite terminal status, so completed/aborted conversations don't pin
 * memory for the lifetime of the daemon.
 *
 * No-op when the conversationId is unknown — completion paths should be
 * idempotent (callers may double-complete on retry).
 */
export function completeConversation(conversationId: string): void {
  store.delete(conversationId);
}

/** Test-only: returns the current store size for assertions. */
export function _getStoreSize(): number {
  return store.size;
}

/** Test-only: clears the store. */
export function _resetStore(): void {
  store.clear();
}
