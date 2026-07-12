import type {
  FinalProductEvidenceBundle,
  QualityEvidenceRef,
  QualityFixTaskDraft,
  QualityIssue,
  QualityReviewOutcome,
} from './types.js';
import { qualityIssuesFromProductEvidence } from './internal-utils.js';

export interface ProductReviewResult {
  outcome: QualityReviewOutcome;
  score: number;
  issues: QualityIssue[];
  evidence: QualityEvidenceRef[];
  fixTasks: QualityFixTaskDraft[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'from',
  'is', 'are', 'be', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'into', 'onto', 'our',
  'my', 'your', 'their', 'add', 'build', 'create', 'implement', 'make', 'support', 'enable',
  'allow', 'show', 'display', 'render', 'ensure', 'improve', 'expose', 'should', 'will', 'can',
  'must', 'have', 'has', 'use', 'using', 'new', 'also', 'then',
]);

function tokenizeObjective(objective: string): string[] {
  const cleaned = objective.toLowerCase().replace(/[^\w\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(words)).slice(0, 12);
}

export function objectiveVsVisibleSurface(
  objective: string,
  bundle: FinalProductEvidenceBundle,
): QualityIssue[] {
  const surfaceText = bundle.productHarness?.extractedSurfaceText ?? '';
  if (!surfaceText.trim()) return [];
  if (!objective.trim()) return [];

  const ngrams = tokenizeObjective(objective);
  if (ngrams.length === 0) return [];

  const surfaceLower = surfaceText.toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const n of ngrams) {
    if (surfaceLower.includes(n)) matched.push(n);
    else missing.push(n);
  }

  if (missing.length < 2) return [];

  return [
    {
      severity: 'warning',
      code: 'product.objective_visible_mismatch',
      origin: 'product_reviewer:objective_visible_surface',
      message: `The objective mentions ${missing.length} prominent claim(s) that do not appear in the visible product surface: ${missing.slice(0, 5).join(', ')}.`,
      suggestedAction:
        'Verify the feature actually exposes the promised surface (headings, buttons, aria-labels, links). If the objective wording is intentionally abstract, paraphrase it in the workflow metadata so the deterministic check stops flagging.',
      safeContext: {
        missingClaims: missing.slice(0, 5),
        matchedClaims: matched.slice(0, 5),
        surfaceTextChars: surfaceText.length,
        inspectedFileCount: bundle.productHarness?.inspectedFiles?.length ?? 0,
      },
    },
  ];
}

function severityPenalty(severity: QualityIssue['severity']): number {
  if (severity === 'blocking') return 0.45;
  if (severity === 'error') return 0.25;
  if (severity === 'warning') return 0.1;
  return 0;
}

function issueOutcome(issues: QualityIssue[]): QualityReviewOutcome {
  if (issues.some((issue) => issue.severity === 'blocking')) return 'blocked';
  if (issues.some((issue) => issue.severity === 'error' || issue.severity === 'warning')) return 'needs_fixes';
  return 'passed';
}

function issueFixTask(issue: QualityIssue): QualityFixTaskDraft {
  return {
    title: `Fix product review issue: ${issue.code}`,
    kind: 'cli_spawn',
    objective: `${issue.message}\n\nSuggested action: ${issue.suggestedAction}`,
    acceptanceCriteria:
      `Product review issue ${issue.code} is resolved, the relevant feature is integrated into the existing product surface, and the focused build/browser evidence passes.`,
    metadata: {
      issue_code: issue.code,
      severity: issue.severity,
      origin: issue.origin,
      safe_context: issue.safeContext ?? {},
    },
  };
}

export function reviewFinalProductEvidenceBundle(
  bundle: FinalProductEvidenceBundle,
): ProductReviewResult {
  const harnessIssues = qualityIssuesFromProductEvidence(
    bundle.productHarness.issues,
    `product_harness:${bundle.productHarness.harness}`,
  );

  const currentErrorIssues: QualityIssue[] = bundle.structuredErrors.slice(0, 12).map((error) => ({
    severity: 'warning',
    code: String(error['code'] ?? 'structured_workflow_error'),
    origin: String(error['origin'] ?? 'workflow_debug_log'),
    message: String(error['message'] ?? 'Structured workflow error is present in the current debug log.'),
    suggestedAction: String(error['suggested_action'] ?? 'Inspect the structured error and resolve it before accepting product quality.'),
    safeContext: {
      task_id: error['task_id'] ?? error['context'],
    },
  }));

  const objectiveIssues = objectiveVsVisibleSurface(bundle.workflow.objective, bundle);
  const issues = [...harnessIssues, ...currentErrorIssues, ...objectiveIssues];
  const score = Math.max(0, 1 - issues.reduce((sum, issue) => sum + severityPenalty(issue.severity), 0));
  const evidence: QualityEvidenceRef[] = [
    {
      kind: 'browser',
      label: 'static product harness',
      summary: `${bundle.productHarness.status}: ${bundle.productHarness.issues.length} issue(s), ${bundle.productHarness.inspectedFiles.length} inspected file(s).`,
      metadata: {
        harness: bundle.productHarness.harness,
        checkedRoots: bundle.productHarness.checkedRoots,
        inspectedFiles: bundle.productHarness.inspectedFiles.slice(0, 40),
      },
    },
    {
      kind: 'debug_log',
      label: 'workflow debug errors',
      summary: `${bundle.structuredErrors.length} current structured error(s), ${bundle.historicalErrors.length} historical error(s).`,
    },
  ];

  return {
    outcome: issueOutcome(issues),
    score,
    issues,
    evidence,
    fixTasks: issues
      .filter((issue) => issue.severity === 'blocking' || issue.severity === 'error')
      .map(issueFixTask),
  };
}
