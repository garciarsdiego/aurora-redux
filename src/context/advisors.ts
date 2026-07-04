import type Database from 'better-sqlite3';
import {
  createContextMessage,
  createContextThread,
  ensureRunContextChannel,
  recordContextDecision,
  type ContextDecisionRow,
  type ContextMessageRow,
  type ContextThreadRow,
} from './store.js';
import type { ContextDecisionKind } from './types.js';
import { redactContextBody } from './redaction.js';
import {
  createCouncilRunLive,
  type CouncilParticipant,
  type CouncilRunRecord,
  type AdvisorInvoker,
} from './council.js';

export type AdvisorReviewOutcome = 'approve' | 'reject' | 'retry' | 'audit' | 'note';

export interface RecordAdvisorContextReviewInput {
  workspace: string;
  runId: string;
  taskId?: string | null;
  advisorName: string;
  outcome: AdvisorReviewOutcome;
  summary: string;
  recommendation?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface AdvisorContextReviewRecord {
  thread: ContextThreadRow;
  message: ContextMessageRow;
  decision: ContextDecisionRow;
}

export interface RecordDebateContextSynthesisInput {
  workspace: string;
  runId: string;
  taskId?: string | null;
  topic: string;
  participants: string[];
  summary: string;
  consensus?: string;
  dissent?: string;
  metadata?: Record<string, unknown>;
}

function decisionKindForOutcome(outcome: AdvisorReviewOutcome): ContextDecisionKind {
  if (outcome === 'approve' || outcome === 'reject' || outcome === 'retry' || outcome === 'audit') {
    return outcome;
  }
  return 'note';
}

export function recordAdvisorContextReview(
  db: Database.Database,
  input: RecordAdvisorContextReviewInput,
): AdvisorContextReviewRecord {
  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = createContextThread(db, {
    channelId: channel.id,
    kind: 'advisor',
    title: `${input.advisorName} review${input.taskId ? ` for ${input.taskId}` : ''}`,
    runId: input.runId,
    taskId: input.taskId ?? null,
    metadata: {
      advisor_name: input.advisorName,
      outcome: input.outcome,
      confidence: input.confidence ?? null,
      ...(input.metadata ?? {}),
    },
  });
  const body = [
    redactContextBody(input.summary),
    input.recommendation ? `Recommendation: ${input.recommendation}` : '',
  ].filter(Boolean).join('\n\n');
  const message = createContextMessage(db, {
    threadId: thread.id,
    senderType: 'advisor',
    senderId: input.advisorName,
    kind: 'advisor_review',
    body,
    metadata: {
      eventType: 'advisor_context_review',
      advisor_name: input.advisorName,
      outcome: input.outcome,
      confidence: input.confidence ?? null,
    },
  });
  const decision = recordContextDecision(db, {
    threadId: thread.id,
    runId: input.runId,
    taskId: input.taskId ?? null,
    kind: decisionKindForOutcome(input.outcome),
    status: 'recorded',
    rationale: body,
    metadata: {
      advisor_name: input.advisorName,
      message_id: message.id,
      confidence: input.confidence ?? null,
      ...(input.metadata ?? {}),
    },
  });
  return { thread, message, decision };
}

export function safeRecordAdvisorContextReview(
  db: Database.Database,
  input: RecordAdvisorContextReviewInput,
): void {
  try {
    recordAdvisorContextReview(db, input);
  } catch {
    // Advisor context capture must never block execution or review.
  }
}

export function recordDebateContextSynthesis(
  db: Database.Database,
  input: RecordDebateContextSynthesisInput,
): AdvisorContextReviewRecord {
  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = createContextThread(db, {
    channelId: channel.id,
    kind: 'advisor',
    title: `AI council debate: ${input.topic}`,
    runId: input.runId,
    taskId: input.taskId ?? null,
    metadata: {
      council_topic: input.topic,
      participants: input.participants,
      ...(input.metadata ?? {}),
    },
  });
  const body = [
    `Topic: ${input.topic}`,
    `Participants: ${input.participants.join(', ')}`,
    `Summary: ${redactContextBody(input.summary)}`,
    input.consensus ? `Consensus: ${redactContextBody(input.consensus)}` : '',
    input.dissent ? `Dissent: ${redactContextBody(input.dissent)}` : '',
  ].filter(Boolean).join('\n');
  const message = createContextMessage(db, {
    threadId: thread.id,
    senderType: 'advisor',
    senderId: 'ai-council',
    kind: 'advisor_review',
    body,
    metadata: {
      eventType: 'debate_context_synthesis',
      topic: input.topic,
      participants: input.participants,
    },
  });
  const decision = recordContextDecision(db, {
    threadId: thread.id,
    runId: input.runId,
    taskId: input.taskId ?? null,
    kind: 'note',
    status: 'recorded',
    rationale: body,
    metadata: {
      message_id: message.id,
      topic: input.topic,
      participants: input.participants,
    },
  });
  return { thread, message, decision };
}

export function safeRecordDebateContextSynthesis(
  db: Database.Database,
  input: RecordDebateContextSynthesisInput,
): void {
  try {
    recordDebateContextSynthesis(db, input);
  } catch {
    // Debate context capture must never block execution or review.
  }
}

// ── F6-4: Live council helper ────────────────────────────────────────────────
// Thin re-export wrapper so callers that already import from
// `src/context/advisors.ts` (the existing advisor-context surface) can reach
// the live council without pulling in the council module explicitly. This
// keeps the public import surface stable across modules and gives the route
// handler a single place to import from.

export interface RunLiveCouncilInput {
  workspace: string;
  runId: string;
  taskId?: string | null;
  topic: string;
  source?: 'workflow' | 'task' | 'debug_bundle' | 'quality_review' | 'handoff';
  participants: CouncilParticipant[];
  contextSummary?: string;
  actor?: string;
  /**
   * Optional advisor invoker — used by tests to inject canned responses.
   * Production code should omit this so the registry-backed invoker is used.
   */
  advisorInvoker?: AdvisorInvoker;
}

/**
 * F6-4: Run a council with real advisor LLM calls. ALWAYS dry-run; the
 * resulting fix-task draft is ALWAYS approval_status='pending'. Operator
 * must explicitly approve via the existing fix-task endpoints before any
 * execution path can pick the draft up.
 */
export async function runLiveCouncil(
  db: Database.Database,
  input: RunLiveCouncilInput,
): Promise<CouncilRunRecord> {
  return createCouncilRunLive(db, {
    workspace: input.workspace,
    runId: input.runId,
    taskId: input.taskId ?? null,
    topic: input.topic,
    source: input.source ?? 'workflow',
    participants: input.participants,
    contextSummary: input.contextSummary,
    runMode: 'dry-run', // Forced; live council is never approved-run.
    actor: input.actor ?? 'dashboard',
    advisorInvoker: input.advisorInvoker,
  });
}
