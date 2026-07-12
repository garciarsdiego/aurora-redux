/**
 * Shared scaffolding for the review-request MCP tools
 * (request_architecture_review / request_product_review): workflow lookup +
 * approved_by validation, run_mode → approval_status mapping, and the
 * channel → thread → message → event context-recording sequence.
 */

import type Database from 'better-sqlite3';
import { insertEvent } from '../../db/persist.js';
import { createContextMessage, createContextThread, ensureRunContextChannel } from '../../context/store.js';
import type { QualityApprovalStatus, QualityRunMode } from '../../quality/types.js';

export function resolveApprovalStatus(runMode: QualityRunMode): QualityApprovalStatus {
  return runMode === 'approved-run' ? 'approved' : 'not_required';
}

/**
 * Loads the workflow row for a review request and validates that approved_by
 * is present when run_mode=approved-run. Throws on missing workflow/approval.
 */
export function loadReviewWorkflow(
  db: Database.Database,
  input: { workflow_id: string; run_mode: QualityRunMode; approved_by?: string },
): Record<string, unknown> {
  const workflow = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(input.workflow_id) as Record<string, unknown> | undefined;
  if (!workflow) throw new Error(`Workflow not found: ${input.workflow_id}`);
  if (input.run_mode === 'approved-run' && !input.approved_by?.trim()) {
    throw new Error('approved_by is required when run_mode=approved-run');
  }
  return workflow;
}

export interface RecordReviewContextOptions {
  workspace: string;
  workflowId: string;
  reviewId: string;
  runMode: QualityRunMode;
  threadTitle: string;
  senderId: string;
  body: string;
  /** Extra fields merged into the context-message metadata (e.g. score). */
  messageMetadata?: Record<string, unknown>;
  eventType: string;
  /** Review-specific fields merged into the event payload (e.g. outcome). */
  eventPayload: Record<string, unknown>;
  approvedBy: string | null;
}

/**
 * Records the review in the run context channel (thread + message) and emits
 * the corresponding workflow event with the shared approval/audit fields.
 */
export function recordReviewContext(db: Database.Database, opts: RecordReviewContextOptions): void {
  const approvalStatus = resolveApprovalStatus(opts.runMode);
  const channel = ensureRunContextChannel(db, {
    workspace: opts.workspace,
    runId: opts.workflowId,
    title: `Run ${opts.workflowId}`,
  });
  const thread = createContextThread(db, {
    channelId: channel.id,
    kind: 'decision',
    title: opts.threadTitle,
    runId: opts.workflowId,
    metadata: { quality_review_id: opts.reviewId, run_mode: opts.runMode },
  });
  createContextMessage(db, {
    threadId: thread.id,
    senderType: 'reviewer',
    senderId: opts.senderId,
    kind: 'advisor_review',
    body: opts.body,
    metadata: {
      quality_review_id: opts.reviewId,
      ...(opts.messageMetadata ?? {}),
      run_mode: opts.runMode,
      approval_status: approvalStatus,
      audit_status: 'recorded',
    },
  });
  insertEvent(db, {
    workflow_id: opts.workflowId,
    task_id: null,
    type: opts.eventType,
    payload: {
      quality_review_id: opts.reviewId,
      ...opts.eventPayload,
      run_mode: opts.runMode,
      approval_status: approvalStatus,
      audit_status: 'recorded',
      approved_by: opts.approvedBy,
    },
  });
}
