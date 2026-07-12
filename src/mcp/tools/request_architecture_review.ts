import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { buildFinalProductEvidenceBundle } from '../../quality/final-evidence.js';
import { saveQualityReview } from '../../quality/store.js';
import type { QualityIssue } from '../../quality/types.js';
import { redactContextJson } from '../../context/redaction.js';
import { loadReviewWorkflow, recordReviewContext, resolveApprovalStatus } from './review-common.js';

const RequestArchitectureReviewSchema = z.object({
  workflow_id: z.string().min(1),
  run_mode: z.enum(['dry-run', 'approved-run']).optional().default('dry-run'),
  approved_by: z.string().optional(),
});

function architectureIssuesFromEvidence(workflowId: string, evidence: ReturnType<typeof buildFinalProductEvidenceBundle>): QualityIssue[] {
  return evidence.productHarness.issues
    .filter((issue) =>
      issue.code === 'sidecar_dom_island' ||
      issue.code === 'possible_duplicate_domain_store' ||
      /architecture|sidecar|store|integration/i.test(issue.code),
    )
    .map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      origin: 'architecture_review:static_product_harness',
      message: issue.message,
      suggestedAction: issue.suggestedAction,
      safeContext: {
        workflow_id: workflowId,
        ...(issue.safeContext ?? {}),
      },
    }));
}

export async function requestArchitectureReviewTool(raw: unknown): Promise<string> {
  const input = RequestArchitectureReviewSchema.parse(raw);
  const approvalStatus = resolveApprovalStatus(input.run_mode);
  const db = initDb(getDbPath());
  try {
    const workflow = loadReviewWorkflow(db, input);

    const evidence = buildFinalProductEvidenceBundle(db, input.workflow_id);
    const issues = architectureIssuesFromEvidence(input.workflow_id, evidence);
    const outcome = issues.some((issue) => issue.severity === 'blocking')
      ? 'blocked'
      : issues.length > 0
        ? 'needs_fixes'
        : 'passed';
    const review = saveQualityReview(db, {
      workflowId: input.workflow_id,
      scope: 'workflow_final',
      reviewerKind: 'heuristic',
      reviewerModel: null,
      outcome,
      score: issues.length === 0 ? 1 : 0.5,
      issues,
      evidence: [
        {
          kind: 'context',
          label: 'architecture contract and static integration harness',
          summary: `${evidence.productHarness.status}: ${issues.length} architecture issue(s).`,
          metadata: {
            inspectedFiles: evidence.productHarness.inspectedFiles.slice(0, 40),
            checkedRoots: evidence.productHarness.checkedRoots,
          },
        },
      ],
      fixTasks: issues
        .filter((issue) => issue.severity === 'blocking' || issue.severity === 'error')
        .map((issue) => ({
          title: `Fix architecture issue: ${issue.code}`,
          kind: 'cli_spawn',
          objective: `${issue.message}\n\nSuggested action: ${issue.suggestedAction}`,
          acceptanceCriteria: `Architecture issue ${issue.code} is resolved and the feature integrates through the recorded architecture contract.`,
          metadata: { issue_code: issue.code, safe_context: issue.safeContext ?? {} },
        })),
      runMode: input.run_mode,
      approvalStatus,
      auditStatus: 'recorded',
    });

    recordReviewContext(db, {
      workspace: String(workflow['workspace']),
      workflowId: input.workflow_id,
      reviewId: review.id,
      runMode: input.run_mode,
      threadTitle: 'Architecture review',
      senderId: 'omniforge_request_architecture_review',
      body: `Architecture review ${outcome} with ${issues.length} issue(s).`,
      eventType: 'mcp_architecture_review_requested',
      eventPayload: {
        outcome,
        issue_count: issues.length,
      },
      approvedBy: input.approved_by ?? null,
    });

    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      review_id: review.id,
      outcome,
      issues,
      run_mode: input.run_mode,
      approval_status: approvalStatus,
      audit_status: 'recorded',
    }), null, 2);
  } finally {
    db.close();
  }
}
