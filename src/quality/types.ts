export type QualityReviewScope = 'task' | 'workflow_final';

export type QualityReviewerKind =
  | 'heuristic'
  | 'light_ai'
  | 'robust_ai'
  | 'browser_harness';

export type QualityReviewOutcome = 'passed' | 'needs_fixes' | 'blocked' | 'skipped';

export type QualityRunMode = 'dry-run' | 'approved-run';

export type QualityApprovalStatus =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected';

export type QualityAuditStatus =
  | 'not_required'
  | 'pending'
  | 'recorded'
  | 'failed';

export interface QualityIssue {
  severity: 'info' | 'warning' | 'error' | 'blocking';
  code: string;
  origin: string;
  message: string;
  suggestedAction: string;
  safeContext?: Record<string, unknown>;
}

export interface QualityEvidenceRef {
  kind: 'task_output' | 'filesystem' | 'browser' | 'debug_log' | 'artifact' | 'context' | 'other';
  label: string;
  path?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskQualityEvidenceBundle {
  workflow: {
    id: string;
    workspace: string;
    objective: string;
    status: string;
  };
  task: {
    id: string;
    name: string;
    kind: string;
    status: string;
    model: string | null;
    executorHint: string | null;
    acceptanceCriteria: string | null;
    retryCount: number;
    refineCount: number;
  };
  executionContext: {
    workspaceDir: string;
    worktreeRoot: string | null;
    outputDir: string | null;
    sourceCwd: string | null;
  };
  output: {
    chars: number;
    preview: string;
  };
  filesystem: {
    canDecide: boolean;
    verdict: 'pass' | 'fail';
    feedback: string;
    evidence: Array<{ criterion: string; status: 'met' | 'unmet' | 'ambiguous'; proof: string }>;
    summary: {
      files_verified: string[];
      files_missing: string[];
      files_too_short: string[];
    };
  };
  artifacts: QualityEvidenceRef[];
  eventsTail: Array<Record<string, unknown>>;
  runtimeEventsTail: Array<Record<string, unknown>>;
  contextPacketsTail: Array<Record<string, unknown>>;
  handoffsTail: Array<Record<string, unknown>>;
}

export interface ProductEvidenceIssue {
  severity: 'warning' | 'error' | 'blocking';
  code: string;
  message: string;
  suggestedAction: string;
  safeContext?: Record<string, unknown>;
}

export interface ProductEvidenceHarnessResult {
  status: 'passed' | 'failed' | 'skipped';
  harness: 'static_web_contract';
  checkedRoots: string[];
  inspectedFiles: string[];
  issues: ProductEvidenceIssue[];
  notes: string[];
  extractedSurfaceText: string;
}

/**
 * F6-2: Compact summary of the Playwright product harness, embedded in the
 * final evidence bundle so the dashboard and reviewer LLM see browser-driven
 * evidence alongside the static web product harness.
 */
export interface PlaywrightHarnessEvidence {
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  mismatches: Array<{
    kind: 'selector_missing' | 'text_mismatch';
    selector: string;
    expectedText?: string;
    actualText?: string;
  }>;
  screenshotPaths: string[];
  appUrl?: string;
}

export interface FinalProductEvidenceBundle {
  workflow: {
    id: string;
    workspace: string;
    objective: string;
    status: string;
    metadata: Record<string, unknown>;
  };
  tasks: Array<{
    id: string;
    name: string;
    kind: string;
    status: string;
    model: string | null;
    executorHint: string | null;
    outputChars: number;
    acceptanceCriteria: string | null;
  }>;
  taskQualityReviews: Array<Record<string, unknown>>;
  productHarness: ProductEvidenceHarnessResult;
  /**
   * F6-2: Optional Playwright harness result. Only populated when the final
   * reviewer is allowed to invoke Playwright (mode !== 'off' AND the workflow
   * has an architecture contract with testSelectors AND the projectRoot
   * advertises a web app via package.json).
   */
  playwrightHarness?: PlaywrightHarnessEvidence;
  structuredErrors: Array<Record<string, unknown>>;
  historicalErrors: Array<Record<string, unknown>>;
  terminalTail: string[];
}

export interface QualityFixTaskDraft {
  title: string;
  kind: string;
  objective: string;
  dependsOn?: string[];
  acceptanceCriteria: string;
  metadata?: Record<string, unknown>;
}

export interface QualityReviewRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  scope: QualityReviewScope;
  reviewer_kind: QualityReviewerKind;
  reviewer_model: string | null;
  outcome: QualityReviewOutcome;
  score: number | null;
  issues_json: string;
  evidence_json: string;
  fix_tasks_json: string;
  approval_status: QualityApprovalStatus;
  audit_status: QualityAuditStatus;
  run_mode: QualityRunMode;
  created_at: number;
}

export interface CreateQualityReviewInput {
  workflowId: string;
  taskId?: string | null;
  scope: QualityReviewScope;
  reviewerKind: QualityReviewerKind;
  reviewerModel?: string | null;
  outcome: QualityReviewOutcome;
  score?: number | null;
  issues?: QualityIssue[];
  evidence?: QualityEvidenceRef[];
  fixTasks?: QualityFixTaskDraft[];
  approvalStatus?: QualityApprovalStatus;
  auditStatus?: QualityAuditStatus;
  runMode?: QualityRunMode;
  createdAt?: number;
}
