import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { buildFinalProductEvidenceBundle } from '../../quality/final-evidence.js';
import { reviewFinalProductEvidenceBundle } from '../../quality/product-reviewer.js';
import { saveQualityReview } from '../../quality/store.js';
import { redactContextJson } from '../../context/redaction.js';
import { loadReviewWorkflow, recordReviewContext, resolveApprovalStatus } from './review-common.js';

const RequestProductReviewSchema = z.object({
  workflow_id: z.string().min(1),
  run_mode: z.enum(['dry-run', 'approved-run']).optional().default('dry-run'),
  approved_by: z.string().optional(),
});

export async function requestProductReviewTool(raw: unknown): Promise<string> {
  const input = RequestProductReviewSchema.parse(raw);
  const approvalStatus = resolveApprovalStatus(input.run_mode);
  const db = initDb(getDbPath());
  try {
    const workflow = loadReviewWorkflow(db, input);

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
      approvalStatus,
      auditStatus: 'recorded',
    });

    recordReviewContext(db, {
      workspace: String(workflow['workspace']),
      workflowId: input.workflow_id,
      reviewId: review.id,
      runMode: input.run_mode,
      threadTitle: 'Product quality review',
      senderId: 'omniforge_request_product_review',
      body: `Product review ${result.outcome} with ${result.issues.length} issue(s).`,
      messageMetadata: { score: result.score },
      eventType: 'mcp_product_review_requested',
      eventPayload: {
        outcome: result.outcome,
        score: result.score,
        issue_count: result.issues.length,
        fix_task_count: result.fixTasks.length,
      },
      approvedBy: input.approved_by ?? null,
    });

    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      review_id: review.id,
      outcome: result.outcome,
      score: result.score,
      issues: result.issues,
      fix_tasks: result.fixTasks,
      run_mode: input.run_mode,
      approval_status: approvalStatus,
      audit_status: 'recorded',
    }), null, 2);
  } finally {
    db.close();
  }
}
