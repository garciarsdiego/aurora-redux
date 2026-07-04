import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { insertEvent } from '../../db/persist.js';
import { buildFinalProductEvidenceBundle } from '../../quality/final-evidence.js';
import { reviewFinalProductEvidenceBundle } from '../../quality/product-reviewer.js';
import { saveQualityReview } from '../../quality/store.js';
import { createContextMessage, createContextThread, ensureRunContextChannel } from '../../context/store.js';
import { redactContextJson } from '../../context/redaction.js';

const RequestProductReviewSchema = z.object({
  workflow_id: z.string().min(1),
  run_mode: z.enum(['dry-run', 'approved-run']).optional().default('dry-run'),
  approved_by: z.string().optional(),
});

export async function requestProductReviewTool(raw: unknown): Promise<string> {
  const input = RequestProductReviewSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const workflow = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(input.workflow_id) as Record<string, unknown> | undefined;
    if (!workflow) throw new Error(`Workflow not found: ${input.workflow_id}`);
    if (input.run_mode === 'approved-run' && !input.approved_by?.trim()) {
      throw new Error('approved_by is required when run_mode=approved-run');
    }

    const evidence = buildFinalProductEvidenceBundle(db, input.workflow_id);
    const result = reviewFinalProductEvidenceBundle(evidence);
    const review = saveQualityReview(db, {
      workflowId: input.workflow_id,
      scope: 'workflow_final',
      reviewerKind: 'browser_harness',
      reviewerModel: null,
      outcome: result.outcome,
      score: result.score,
      issues: result.issues,
      evidence: result.evidence,
      fixTasks: result.fixTasks,
      runMode: input.run_mode,
      approvalStatus: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
      auditStatus: 'recorded',
    });

    const channel = ensureRunContextChannel(db, {
      workspace: String(workflow['workspace']),
      runId: input.workflow_id,
      title: `Run ${input.workflow_id}`,
    });
    const thread = createContextThread(db, {
      channelId: channel.id,
      kind: 'decision',
      title: 'Product quality review',
      runId: input.workflow_id,
      metadata: { quality_review_id: review.id, run_mode: input.run_mode },
    });
    createContextMessage(db, {
      threadId: thread.id,
      senderType: 'reviewer',
      senderId: 'omniforge_request_product_review',
      kind: 'advisor_review',
      body: `Product review ${result.outcome} with ${result.issues.length} issue(s).`,
      metadata: {
        quality_review_id: review.id,
        score: result.score,
        run_mode: input.run_mode,
        approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
        audit_status: 'recorded',
      },
    });
    insertEvent(db, {
      workflow_id: input.workflow_id,
      task_id: null,
      type: 'mcp_product_review_requested',
      payload: {
        quality_review_id: review.id,
        outcome: result.outcome,
        score: result.score,
        issue_count: result.issues.length,
        fix_task_count: result.fixTasks.length,
        run_mode: input.run_mode,
        approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
        audit_status: 'recorded',
        approved_by: input.approved_by ?? null,
      },
    });

    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      review_id: review.id,
      outcome: result.outcome,
      score: result.score,
      issues: result.issues,
      fix_tasks: result.fixTasks,
      run_mode: input.run_mode,
      approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
      audit_status: 'recorded',
    }), null, 2);
  } finally {
    db.close();
  }
}
