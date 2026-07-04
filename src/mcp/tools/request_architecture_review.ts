import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { insertEvent } from '../../db/persist.js';
import { buildFinalProductEvidenceBundle } from '../../quality/final-evidence.js';
import { saveQualityReview } from '../../quality/store.js';
import type { QualityIssue } from '../../quality/types.js';
import { createContextMessage, createContextThread, ensureRunContextChannel } from '../../context/store.js';
import { redactContextJson } from '../../context/redaction.js';

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
  const db = initDb(getDbPath());
  try {
    const workflow = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(input.workflow_id) as Record<string, unknown> | undefined;
    if (!workflow) throw new Error(`Workflow not found: ${input.workflow_id}`);
    if (input.run_mode === 'approved-run' && !input.approved_by?.trim()) {
      throw new Error('approved_by is required when run_mode=approved-run');
    }

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
      title: 'Architecture review',
      runId: input.workflow_id,
      metadata: { quality_review_id: review.id, run_mode: input.run_mode },
    });
    createContextMessage(db, {
      threadId: thread.id,
      senderType: 'reviewer',
      senderId: 'omniforge_request_architecture_review',
      kind: 'advisor_review',
      body: `Architecture review ${outcome} with ${issues.length} issue(s).`,
      metadata: {
        quality_review_id: review.id,
        run_mode: input.run_mode,
        approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
        audit_status: 'recorded',
      },
    });
    insertEvent(db, {
      workflow_id: input.workflow_id,
      task_id: null,
      type: 'mcp_architecture_review_requested',
      payload: {
        quality_review_id: review.id,
        outcome,
        issue_count: issues.length,
        run_mode: input.run_mode,
        approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
        audit_status: 'recorded',
        approved_by: input.approved_by ?? null,
      },
    });

    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      review_id: review.id,
      outcome,
      issues,
      run_mode: input.run_mode,
      approval_status: input.run_mode === 'approved-run' ? 'approved' : 'not_required',
      audit_status: 'recorded',
    }), null, 2);
  } finally {
    db.close();
  }
}
