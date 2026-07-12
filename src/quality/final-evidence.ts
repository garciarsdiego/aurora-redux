import type Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildWorkflowDebugLog } from '../db/workflow-debug-log.js';
import { redactContextJson, redactContextText } from '../context/redaction.js';
import { listQualityReviewsForWorkflow } from './store.js';
import type {
  FinalProductEvidenceBundle,
  PlaywrightHarnessEvidence,
  ProductEvidenceHarnessResult,
  ProductEvidenceIssue,
} from './types.js';
import { reviewArchitectureIntegration } from './architecture-reviewer.js';
import type { ArchitectureContract } from '../workflow-modes/existing-code-feature.js';
import type {
  CanvasRegionCheck,
  InteractionCheck,
  PlaywrightHarnessResult,
} from './playwright-product-harness.js';
import { isCanvasRegionCheckArray, isInteractionCheckArray } from './visual-check-guards.js';
import { safeParseJson, tableExists } from './internal-utils.js';

interface TaskRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  model: string | null;
  executor_hint: string | null;
  input_json: string | null;
  output_json: string | null;
  acceptance_criteria: string | null;
}

function asArchitectureContract(value: unknown): ArchitectureContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row['runId'] !== 'string' ||
    typeof row['projectRoot'] !== 'string' ||
    (row['appType'] !== 'react' && row['appType'] !== 'node' && row['appType'] !== 'unknown') ||
    !Array.isArray(row['existingStateStores']) ||
    !Array.isArray(row['existingUiSurfaces']) ||
    !Array.isArray(row['allowedFiles']) ||
    !Array.isArray(row['forbiddenPatterns']) ||
    !Array.isArray(row['requiredIntegrationPoints']) ||
    !Array.isArray(row['testSelectors'])
  ) {
    return null;
  }
  return {
    runId: row['runId'],
    projectRoot: row['projectRoot'],
    appType: row['appType'],
    existingStateStores: row['existingStateStores'].filter((item): item is string => typeof item === 'string'),
    existingUiSurfaces: row['existingUiSurfaces'].filter((item): item is string => typeof item === 'string'),
    allowedFiles: row['allowedFiles'].filter((item): item is string => typeof item === 'string'),
    forbiddenPatterns: row['forbiddenPatterns'].filter((item): item is string => typeof item === 'string'),
    requiredIntegrationPoints: row['requiredIntegrationPoints'].filter((item): item is string => typeof item === 'string'),
    testSelectors: row['testSelectors'].filter((item): item is string => typeof item === 'string'),
  };
}

export function loadArchitectureContractForWorkflow(
  db: Database.Database,
  workflowId: string,
): ArchitectureContract | null {
  if (!tableExists(db, 'context_decisions')) return null;
  const rows = db
    .prepare(
      `SELECT metadata_json
         FROM context_decisions
        WHERE run_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
    )
    .all(workflowId) as Array<{ metadata_json: string | null }>;

  for (const row of rows) {
    const metadata = safeParseJson(row.metadata_json);
    if (metadata['decision_type'] !== 'architecture_contract') continue;
    const contract = asArchitectureContract(metadata['architecture_contract']);
    if (contract) return contract;
  }
  return null;
}

/**
 * FASE C (Visual Reviewer) item 3 — aggregates canvasRegionChecks /
 * interactionChecks declared on any task in the workflow's DAG (persisted
 * into each task's input_json by orchestrate.ts — the Task interface/tasks
 * table carry no dedicated columns for these, same pattern as the
 * deterministic step-kind config) so they can be passed through to the
 * Playwright harness's PlaywrightHarnessInput at the final quality gate.
 *
 * Purely additive/best-effort: tasks with malformed or absent checks are
 * silently skipped rather than throwing, so a single bad task can never
 * break the final quality gate. Queries `tasks` directly (mirrors
 * loadArchitectureContractForWorkflow above) rather than piggybacking on
 * the redacted FinalProductEvidenceBundle, so callers don't need to thread
 * an extra field through the bundle just for this.
 */
export function collectVisualChecksForWorkflow(
  db: Database.Database,
  workflowId: string,
): { canvasRegionChecks: CanvasRegionCheck[]; interactionChecks: InteractionCheck[] } {
  const tasks = db
    .prepare(`SELECT input_json FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC`)
    .all(workflowId) as Array<{ input_json: string | null }>;

  const canvasRegionChecks: CanvasRegionCheck[] = [];
  const interactionChecks: InteractionCheck[] = [];
  for (const task of tasks) {
    const input = safeParseJson(task.input_json);
    const canvasCandidate = input['canvasRegionChecks'];
    if (isCanvasRegionCheckArray(canvasCandidate)) {
      canvasRegionChecks.push(...canvasCandidate);
    }
    const interactionCandidate = input['interactionChecks'];
    if (isInteractionCheckArray(interactionCandidate)) {
      interactionChecks.push(...interactionCandidate);
    }
  }
  return { canvasRegionChecks, interactionChecks };
}

function executionRootsFromTask(task: TaskRow): string[] {
  const input = safeParseJson(task.input_json);
  const exec =
    input['execution_context'] && typeof input['execution_context'] === 'object'
      ? input['execution_context'] as Record<string, unknown>
      : {};
  return ['output_dir', 'worktree_root', 'source_cwd', 'cwd']
    .map((key) => exec[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function collectCandidateRoots(tasks: TaskRow[]): string[] {
  const roots = new Set<string>();
  for (const task of tasks) {
    for (const root of executionRootsFromTask(task)) {
      const absolute = resolve(root);
      if (existsSync(absolute)) roots.add(absolute);
    }
  }
  return [...roots];
}

const INSPECTABLE_EXTENSIONS = new Set(['.html', '.js', '.jsx', '.ts', '.tsx', '.css', '.json']);

function extensionOf(file: string): string {
  const index = file.lastIndexOf('.');
  return index === -1 ? '' : file.slice(index).toLowerCase();
}

function listInspectableFiles(root: string, maxFiles = 80): string[] {
  const out: string[] = [];
  const ignored = new Set(['node_modules', '.git', '.next', 'coverage']);
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 4) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!INSPECTABLE_EXTENSIONS.has(extensionOf(entry.name))) continue;
      try {
        if (statSync(path).size <= 250_000) out.push(path);
      } catch {
        // ignore unreadable files
      }
    }
  };
  walk(root, 0);
  return out;
}

function readFileMap(files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    try {
      map.set(file, readFileSync(file, 'utf-8'));
    } catch {
      // skip unreadable files
    }
  }
  return map;
}

// Hoisted out of the per-line filter callback — a regex literal inside the
// callback would allocate a fresh RegExp object for every inspected line.
const KEY_HANDLING_RE = /\b(keydown|keyup|KeyboardEvent|event\.key|event\.code|e\.key|e\.code|case\s+['"]|Key[A-Z]|Arrow)\b/i;

function readCorpus(filesContent: Map<string, string>): { visible: string; implementation: string } {
  const visibleParts: string[] = [];
  const implementationParts: string[] = [];
  for (const content of filesContent.values()) {
    visibleParts.push(content.slice(0, 80_000));
    const implementationLines = content
      .split(/\r?\n/)
      .filter((line) => KEY_HANDLING_RE.test(line));
    implementationParts.push(implementationLines.join('\n').slice(0, 40_000));
  }
  return {
    visible: redactContextText(visibleParts.join('\n')),
    implementation: redactContextText(implementationParts.join('\n')),
  };
}

function extractSurfaceText(filesContent: Map<string, string>): string {
  const out: string[] = [];
  const HEADING_RE = /<h[1-6][^>]*>([^<]+)<\/h[1-6]>/gi;
  const BUTTON_RE = /<button[^>]*>([^<]+)<\/button>/gi;
  const ANCHOR_RE = /<a[^>]*>([^<]+)<\/a>/gi;
  const ARIA_RE = /\baria-label\s*=\s*["']([^"']+)["']/gi;
  const TITLE_RE = /\btitle\s*=\s*["']([^"']+)["']/gi;
  const JSX_HEADING_RE = /<(Heading|Title|H[1-6])[^>]*>([^<]+)<\/\1>/g;

  for (const [path, content] of filesContent.entries()) {
    if (!/\.(html|tsx|jsx|vue|svelte)$/i.test(path)) continue;
    const slice = content.slice(0, 200_000); // per-file safety cap
    let m: RegExpExecArray | null;
    for (const re of [HEADING_RE, BUTTON_RE, ANCHOR_RE, ARIA_RE, TITLE_RE]) {
      re.lastIndex = 0;
      while ((m = re.exec(slice)) !== null) {
        out.push(m[1]!.trim());
      }
    }
    JSX_HEADING_RE.lastIndex = 0;
    while ((m = JSX_HEADING_RE.exec(slice)) !== null) {
      out.push(m[2]!.trim());
    }
    if (out.length > 2000) break; // global cap
  }
  let joined = out.filter(Boolean).join('\n');
  if (joined.length > 40_000) joined = joined.slice(0, 40_000);
  return redactContextText(joined);
}

// Per-name RegExp cache: the names come from fixed lists in
// detectControlCopyMismatches, so each pattern is compiled at most once.
const KEY_NAME_RE_CACHE = new Map<string, RegExp>();

function hasKey(implementation: string, names: string[]): boolean {
  return names.some((name) => {
    let re = KEY_NAME_RE_CACHE.get(name);
    if (!re) {
      re = new RegExp(`['"\`]${name}['"\`]|\\b${name}\\b`, 'i');
      KEY_NAME_RE_CACHE.set(name, re);
    }
    return re.test(implementation);
  });
}

function pushIssue(
  issues: ProductEvidenceIssue[],
  code: string,
  message: string,
  suggestedAction: string,
  safeContext?: Record<string, unknown>,
): void {
  issues.push({
    severity: 'blocking',
    code,
    message,
    suggestedAction,
    ...(safeContext ? { safeContext } : {}),
  });
}

function detectControlCopyMismatches(visible: string, implementation: string): ProductEvidenceIssue[] {
  const issues: ProductEvidenceIssue[] = [];
  const mentionsEnterStart = /\bEnter\b.{0,80}\b(start|starts|iniciar|come[cç]ar|jogar)\b|\b(start|starts|iniciar|come[cç]ar|jogar)\b.{0,80}\bEnter\b/i.test(visible);
  if (mentionsEnterStart && !hasKey(implementation, ['Enter', 'NumpadEnter'])) {
    pushIssue(
      issues,
      'control_copy_enter_unimplemented',
      'The product copy says Enter starts gameplay, but no Enter/NumpadEnter key handling was found.',
      'Implement Enter start handling or change the visible instructions to match the real controls.',
      { claimed: 'Enter starts game' },
    );
  }

  const mentionsAD = /\bA\s*\/\s*D\b|\bA\s+(and|e)\s+D\b/i.test(visible);
  if (mentionsAD && !(hasKey(implementation, ['KeyA', 'KeyD']) || (hasKey(implementation, ['a']) && hasKey(implementation, ['d'])))) {
    pushIssue(
      issues,
      'control_copy_ad_unimplemented',
      'The product copy advertises A/D movement, but no A/D key handling was found.',
      'Wire A/D movement or change the visible instructions to the implemented movement keys.',
      { claimed: 'A/D movement' },
    );
  }

  const mentionsHold = /\b(hold|segurar)\b|\b(Q|C|Shift)\b.{0,60}\b(hold|segurar)\b/i.test(visible);
  if (mentionsHold && !(hasKey(implementation, ['KeyC', 'KeyQ', 'ShiftLeft', 'ShiftRight']) || hasKey(implementation, ['c', 'q']))) {
    pushIssue(
      issues,
      'control_copy_hold_unimplemented',
      'The product copy advertises a hold control, but no Q/C/Shift hold key handling was found.',
      'Implement hold controls or remove the hold instruction from the UI copy.',
      { claimed: 'hold control' },
    );
  }

  return issues;
}

export function runStaticWebProductHarness(
  tasks: TaskRow[],
  architectureContract: ArchitectureContract | null = null,
): ProductEvidenceHarnessResult {
  const roots = collectCandidateRoots(tasks);
  if (roots.length === 0) {
    return {
      status: 'skipped',
      harness: 'static_web_contract',
      checkedRoots: [],
      inspectedFiles: [],
      issues: [],
      notes: ['No task execution_context roots were available for product evidence.'],
      extractedSurfaceText: '',
    };
  }

  const files = roots.flatMap((root) => listInspectableFiles(root));
  if (files.length === 0) {
    return {
      status: 'skipped',
      harness: 'static_web_contract',
      checkedRoots: roots,
      inspectedFiles: [],
      issues: [],
      notes: ['Execution roots exist, but no inspectable web/product files were found.'],
      extractedSurfaceText: '',
    };
  }

  const filesContent = readFileMap(files);
  const corpus = readCorpus(filesContent);
  const surfaceText = extractSurfaceText(filesContent);
  const issues = [
    ...detectControlCopyMismatches(corpus.visible, corpus.implementation),
    ...reviewArchitectureIntegration({ files, contract: architectureContract }),
  ];
  return {
    status: issues.length > 0 ? 'failed' : 'passed',
    harness: 'static_web_contract',
    checkedRoots: roots,
    inspectedFiles: files,
    issues,
    notes: [
      'Static product harness compared visible control/instruction copy with keyboard handling evidence.',
      architectureContract
        ? 'Static product harness applied the workflow architecture integration contract.'
        : 'No architecture integration contract was available for this static product harness run.',
      'This is not a replacement for Playwright; it is deterministic evidence for final AI review.',
    ],
    extractedSurfaceText: surfaceText,
  };
}

export function buildFinalProductEvidenceBundle(
  db: Database.Database,
  workflowId: string,
): FinalProductEvidenceBundle {
  const workflow = db
    .prepare(`SELECT * FROM workflows WHERE id = ?`)
    .get(workflowId) as Record<string, unknown> | undefined;
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const tasks = db
    .prepare(
      `SELECT id, name, kind, status, model, executor_hint, input_json, output_json, acceptance_criteria
         FROM tasks
        WHERE workflow_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(workflowId) as TaskRow[];
  const debugLog = buildWorkflowDebugLog(db, workflowId);
  const architectureContract = loadArchitectureContractForWorkflow(db, workflowId);
  const productHarness = runStaticWebProductHarness(tasks, architectureContract);

  return {
    workflow: {
      id: String(workflow['id']),
      workspace: String(workflow['workspace']),
      objective: redactContextText(String(workflow['objective'] ?? '')),
      status: String(workflow['status']),
      metadata: redactContextJson(safeParseJson(typeof workflow['metadata'] === 'string' ? workflow['metadata'] : null)),
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      name: redactContextText(task.name),
      kind: task.kind,
      status: task.status,
      model: task.model,
      executorHint: task.executor_hint,
      outputChars: task.output_json?.length ?? 0,
      acceptanceCriteria: task.acceptance_criteria ? redactContextText(task.acceptance_criteria) : null,
    })),
    taskQualityReviews: listQualityReviewsForWorkflow(db, workflowId).map((review) =>
      redactContextJson({ ...review }) as Record<string, unknown>,
    ),
    productHarness: redactContextJson(productHarness),
    structuredErrors: debugLog.structured_errors.map((error) =>
      redactContextJson(error as unknown) as Record<string, unknown>,
    ),
    historicalErrors: debugLog.historical_errors.map((error) =>
      redactContextJson(error as unknown) as Record<string, unknown>,
    ),
    terminalTail: debugLog.terminal_lines.slice(-120),
  };
}

/**
 * F6-2: Lightweight web-app heuristic. Returns true when the projectRoot has
 * a package.json that depends on react, vue, svelte, or next (any tier:
 * dependencies, devDependencies, peerDependencies). Used by the final
 * reviewer to decide whether the Playwright product harness is meaningful.
 *
 * Q4b: Also returns true when the projectRoot has an `index.html` at its
 * root — a zero-build static app (e.g. a plain HTML/canvas/three.js game
 * clone with no framework package.json) is just as "web app" as a React
 * project for the purposes of the Playwright product harness. This widens
 * the existing detection; it never narrows it — the framework-dependency
 * checks below are unchanged.
 */
export function isWebAppProject(projectRoot: string): boolean {
  if (!projectRoot) return false;

  const indexHtmlPath = join(projectRoot, 'index.html');
  if (existsSync(indexHtmlPath)) return true;

  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return false;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return false;
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
  const webHints = ['react', 'vue', 'svelte', 'next'];
  for (const section of sections) {
    const deps = (pkg as Record<string, unknown>)[section];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const names = Object.keys(deps as Record<string, unknown>);
    for (const name of names) {
      if (webHints.includes(name)) return true;
      // Cover scoped/sub packages like @vitejs/plugin-react, next/font, etc.
      if (webHints.some((hint) => name === `@${hint}` || name.startsWith(`@${hint}/`))) return true;
      if (name === 'react-dom' || name === 'vue-router' || name === 'next-auth') return true;
    }
  }
  return false;
}

/**
 * F6-2: Builds a redacted PlaywrightHarnessEvidence record from the raw
 * harness result. Screenshot paths are kept as-is (filesystem paths, not
 * content). Mismatch text is passed through `redactContextJson` because the
 * `actualText` field may carry user-rendered DOM content.
 */
export function buildPlaywrightHarnessEvidence(
  input: Pick<PlaywrightHarnessResult, 'status' | 'reason' | 'mismatches' | 'screenshotPaths' | 'appUrl'>,
): PlaywrightHarnessEvidence {
  const redactedMismatches = redactContextJson(input.mismatches) as PlaywrightHarnessEvidence['mismatches'];
  return {
    status: input.status,
    reason: input.reason,
    mismatches: redactedMismatches,
    screenshotPaths: input.screenshotPaths.slice(0, 6),
    appUrl: input.appUrl,
  };
}

/**
 * F6-2: Translates Playwright harness mismatches into ProductEvidenceIssue
 * entries that the final reviewer can merge into the review's `issues_json`.
 * Severity is `blocking` to match the existing static-harness convention
 * (see `pushIssue` above).
 */
export function playwrightHarnessIssues(
  evidence: PlaywrightHarnessEvidence,
): ProductEvidenceIssue[] {
  if (evidence.status !== 'failed') return [];
  if (evidence.mismatches.length === 0) {
    return [
      {
        severity: 'blocking',
        code: 'playwright_harness_failed',
        message: evidence.reason ?? 'Playwright harness reported failure without specific mismatches.',
        suggestedAction: 'Inspect the harness logs and screenshots; ensure the dev server starts and renders the expected UI.',
        safeContext: evidence.appUrl ? { appUrl: evidence.appUrl } : {},
      },
    ];
  }
  return evidence.mismatches.map((mismatch, index) => {
    const code = mismatch.kind === 'selector_missing'
      ? 'playwright_selector_missing'
      : 'playwright_text_mismatch';
    const message = mismatch.kind === 'selector_missing'
      ? `Playwright did not find the required selector "${mismatch.selector}" on the rendered page.`
      : `Playwright found selector "${mismatch.selector}" but its text did not include the expected substring "${mismatch.expectedText ?? ''}".`;
    return {
      severity: 'blocking',
      code: `${code}_${index + 1}`,
      message,
      suggestedAction: mismatch.kind === 'selector_missing'
        ? 'Implement the missing UI element or update the architecture contract testSelectors to match the real DOM.'
        : 'Render the expected copy in the UI element or update the contract textChecks to reflect the real product copy.',
      safeContext: {
        selector: mismatch.selector,
        expectedText: mismatch.expectedText,
        actualText: mismatch.actualText,
      },
    };
  });
}
