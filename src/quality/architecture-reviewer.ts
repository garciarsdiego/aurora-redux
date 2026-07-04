import { readFileSync } from 'node:fs';

import type { ProductEvidenceIssue } from './types.js';
import type { ArchitectureContract } from '../workflow-modes/existing-code-feature.js';

export interface ArchitectureReviewInput {
  files: string[];
  contract?: ArchitectureContract | null;
  changedFiles?: string[];
  objective?: string;
}

const STANDALONE_OPT_IN_RE = /\b(standalone|sidecar|separate\s+(app|widget|module|panel|tool))\b/i;
function isStandaloneOptIn(objective: string): boolean {
  return STANDALONE_OPT_IN_RE.test(objective);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * If `file` is absolute and lives under `projectRoot`, return the path relative
 * to the root. Otherwise return the (normalized) path unchanged. Used so glob
 * patterns like `src/**` (relative) match callers that pass absolute paths.
 */
function relativizeUnderRoot(file: string, projectRoot: string): string {
  const norm = normalizePath(file);
  const root = normalizePath(projectRoot);
  if (!root) return norm;
  if (norm === root) return '';
  if (norm.startsWith(root + '/')) return norm.slice(root.length + 1);
  return norm; // already relative or outside the root — let downstream handle
}

/**
 * Security guard for the file-content reading detectors: refuse to read files
 * outside the declared `projectRoot`. Without this, a contract pointing at one
 * project could be tricked into opening attacker-controlled paths from a
 * different worktree. Mirrors the workspace boundary applied in v2/tools/core.
 */
function isUnderRoot(file: string, projectRoot: string): boolean {
  if (!projectRoot) return true; // no root configured, allow
  const norm = normalizePath(file);
  const root = normalizePath(projectRoot);
  return norm === root || norm.startsWith(root + '/');
}

function matchesGlob(file: string, pattern: string): boolean {
  // Translate glob to regex: ** -> .*, * -> [^/]*, ? -> [^/], escape others.
  const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i += 2; }
    else if (c === '*') { re += '[^/]*'; i += 1; }
    else if (c === '?') { re += '[^/]'; i += 1; }
    else { re += escape(c); i += 1; }
  }
  return new RegExp(`^${re}$`).test(file);
}

const BUILTIN_TEST_ALLOWLIST = [
  'tests/**',
  'test/**',
  '__tests__/**',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
];

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function readWithCache(file: string, cache: Map<string, string>): string | null {
  const cached = cache.get(file);
  if (cached !== undefined) return cached === '' ? null : cached;
  const content = safeRead(file);
  cache.set(file, content);
  return content === '' ? null : content;
}

function fileLabel(file: string): string {
  return file.replace(/\\/g, '/');
}

function isSidecarRoot(content: string): boolean {
  const createsRootElement =
    /document\.createElement\(\s*['"]div['"]\s*\)/.test(content) &&
    /document\.body\.appendChild\(/.test(content);
  const mountsReactRoot = /\bcreateRoot\(|ReactDOM\.createRoot\(/.test(content);
  const explicitSidecarSelector =
    /\.task-modules-root\b|task-modules-root|data-omniforge-sidecar|sidecar-root/i.test(content);
  const normalRootLookup = /document\.getElementById\(\s*['"]root['"]\s*\)/.test(content);

  return explicitSidecarSelector || (createsRootElement && mountsReactRoot && !normalRootLookup);
}

function isDuplicateStore(content: string): boolean {
  return /\bcreate\s*\(\s*\(\s*set\b/.test(content) &&
    /task|workflow|project|subtask/i.test(content) &&
    /mock|sidecar|module-root|task-module/i.test(content);
}

function detectsParallelDomRoot(
  changedFiles: string[],
  contract: ArchitectureContract,
  contentCache: Map<string, string>,
): ProductEvidenceIssue[] {
  const issues: ProductEvidenceIssue[] = [];
  if (contract.existingUiSurfaces.length === 0) return issues;

  const existingNormalized = contract.existingUiSurfaces.map(normalizePath);

  const reactPattern = /\bcreateRoot\s*\(|\bReactDOM\.render\s*\(|\bReactDOM\.createRoot\s*\(|\bhydrateRoot\s*\(/;
  const reactPatternSources = [
    { re: /\bReactDOM\.createRoot\s*\(/, label: 'ReactDOM.createRoot(' },
    { re: /\bReactDOM\.render\s*\(/, label: 'ReactDOM.render(' },
    { re: /\bhydrateRoot\s*\(/, label: 'hydrateRoot(' },
    { re: /\bcreateRoot\s*\(/, label: 'createRoot(' },
  ];
  const nodePattern = /\bmount\s*\(|\bcreateRoot\s*\(|\bReactDOM\.render\s*\(/;
  const nodePatternSources = [
    { re: /\bReactDOM\.render\s*\(/, label: 'ReactDOM.render(' },
    { re: /\bcreateRoot\s*\(/, label: 'createRoot(' },
    { re: /\bmount\s*\(/, label: 'mount(' },
  ];

  for (const file of changedFiles) {
    // Sec M-1: never read files outside the contract's projectRoot — they are
    // not the contract's concern and could let a poisoned contract trick the
    // reviewer into opening attacker-controlled paths from a different
    // worktree.
    if (!isUnderRoot(file, contract.projectRoot ?? '')) continue;
    const normalized = normalizePath(file);
    if (existingNormalized.some((surface) => normalized.endsWith(surface))) continue;
    const content = readWithCache(file, contentCache);
    if (content === null) continue;

    const sources = contract.appType === 'react' ? reactPatternSources : nodePatternSources;
    const aggregate = contract.appType === 'react' ? reactPattern : nodePattern;
    if (!aggregate.test(content)) continue;

    const matched = sources.find((entry) => entry.re.test(content));
    const matchedPattern = matched?.label ?? 'createRoot(';

    const surfacePreview = contract.existingUiSurfaces.slice(0, 3).join(', ');
    issues.push({
      severity: 'blocking',
      code: 'arch.parallel_dom_root',
      message: `New file ${fileLabel(file)} mounts a ${contract.appType} root (${matchedPattern}) outside the existing UI surfaces.`,
      suggestedAction: `Render this feature inside one of the existing UI surfaces (${surfacePreview}) instead of mounting a parallel root.`,
      safeContext: {
        file: fileLabel(file),
        pattern: matchedPattern,
        appType: contract.appType,
        existingUiSurfaces: contract.existingUiSurfaces.slice(0, 8),
      },
    });
  }

  return issues;
}

function detectsParallelStateStore(
  changedFiles: string[],
  contract: ArchitectureContract,
  contentCache: Map<string, string>,
): ProductEvidenceIssue[] {
  const issues: ProductEvidenceIssue[] = [];
  if (contract.existingStateStores.length === 0) return issues;

  const existingNormalized = contract.existingStateStores.map(normalizePath);

  const libraryPatterns: Array<{ library: string; re: RegExp; nameGated?: boolean }> = [
    { library: 'redux-toolkit', re: /\bcreateSlice\s*\(|\bconfigureStore\s*\(/ },
    { library: 'redux', re: /\bcreateStore\s*\(/ },
    { library: 'zustand', re: /\bcreate\s*\(\s*\(\s*set\b|\bcreate\s*<\s*\w+\s*>\s*\(/ },
    { library: 'pinia', re: /\bdefineStore\s*\(/ },
    { library: 'recoil/jotai', re: /\batom\s*\(\s*\{|\bselector\s*\(\s*\{|\batom\s*\(/ },
    { library: 'react-context', re: /\bcreateContext\s*\(/, nameGated: true },
  ];

  for (const file of changedFiles) {
    // Sec M-1: same boundary as detectsParallelDomRoot.
    if (!isUnderRoot(file, contract.projectRoot ?? '')) continue;
    const normalized = normalizePath(file);
    if (existingNormalized.some((store) => normalized.endsWith(store))) continue;
    const content = readWithCache(file, contentCache);
    if (content === null) continue;

    let detectedLibrary: string | null = null;
    for (const candidate of libraryPatterns) {
      if (!candidate.re.test(content)) continue;
      if (candidate.nameGated && !/state|store|provider/i.test(normalized)) continue;
      detectedLibrary = candidate.library;
      break;
    }
    if (!detectedLibrary) continue;

    const storePreview = contract.existingStateStores.slice(0, 3).join(', ');
    issues.push({
      severity: 'blocking',
      code: 'arch.parallel_state_store',
      message: `New file ${fileLabel(file)} introduces a ${detectedLibrary} state store outside the existing state surfaces.`,
      suggestedAction: `Wire this feature through one of the existing state stores (${storePreview}) instead of creating a parallel ${detectedLibrary} store.`,
      safeContext: {
        file: fileLabel(file),
        detectedLibrary,
        existingStateStores: contract.existingStateStores.slice(0, 8),
      },
    });
  }

  return issues;
}

function validatesAllowedFiles(
  changedFiles: string[],
  contract: ArchitectureContract,
): ProductEvidenceIssue[] {
  const issues: ProductEvidenceIssue[] = [];
  if (contract.allowedFiles.length === 0) return issues;

  const allowed = [...contract.allowedFiles, ...BUILTIN_TEST_ALLOWLIST].map(normalizePath);
  const projectRoot = contract.projectRoot ?? '';

  for (const file of changedFiles) {
    // Callers pass either absolute paths (production) or relative paths (tests
    // / pre-normalized inputs). Glob patterns are relative; relativize first
    // so `src/**` works against an absolute path under `projectRoot`. If the
    // path is already relative (or outside the root), `relativizeUnderRoot`
    // returns the normalized form unchanged.
    const candidate = projectRoot ? relativizeUnderRoot(file, projectRoot) : normalizePath(file);
    const matched = allowed.some((pattern) => matchesGlob(candidate, pattern));
    if (matched) continue;

    issues.push({
      severity: 'blocking',
      code: 'arch.changed_files_outside_contract',
      message: `Changed file ${fileLabel(file)} is outside the architecture contract's allowed file scope.`,
      suggestedAction: `Either move this change inside the allowed scope (e.g. ${contract.allowedFiles.slice(0, 3).join(', ')}) or extend the architecture contract to cover this path.`,
      safeContext: {
        file: fileLabel(file),
        allowedFiles: contract.allowedFiles.slice(0, 8),
      },
    });
  }

  return issues;
}

export function reviewArchitectureIntegration(input: ArchitectureReviewInput): ProductEvidenceIssue[] {
  const issues: ProductEvidenceIssue[] = [];
  const forbidden = input.contract?.forbiddenPatterns ?? [];
  const sidecarForbidden =
    !input.contract || forbidden.some((pattern) => /DOM island|sidecar|separate/i.test(pattern));

  for (const file of input.files) {
    const content = safeRead(file);
    if (!content) continue;
    if (sidecarForbidden && isSidecarRoot(content)) {
      issues.push({
        severity: 'blocking',
        code: 'sidecar_dom_island',
        message:
          'The implementation mounts a separate DOM/root island instead of integrating into the existing product shell.',
        suggestedAction:
          'Move the feature into the existing React/app entry point and state flow, then remove the sidecar root mount.',
        safeContext: {
          file: fileLabel(file),
          contract: input.contract
            ? {
                appType: input.contract.appType,
                requiredIntegrationPoints: input.contract.requiredIntegrationPoints.slice(0, 8),
              }
            : null,
        },
      });
    }
    if (isDuplicateStore(content)) {
      issues.push({
        severity: 'error',
        code: 'possible_duplicate_domain_store',
        message:
          'The implementation appears to create a sidecar/mock domain store instead of using the existing product store.',
        suggestedAction:
          'Wire the feature through the existing state/store module or explicitly justify the new store in the architecture contract.',
        safeContext: { file: fileLabel(file) },
      });
    }
  }

  if (input.contract) {
    const contract = input.contract;
    const objective = input.objective ?? '';
    const changed = input.changedFiles ?? input.files;
    const cap = changed.slice(0, 500);
    const overflow = changed.length > 500;
    if (overflow) {
      issues.push({
        code: 'arch.changed_files_overflow',
        severity: 'warning',
        message: `Workflow touches ${changed.length} files; only first 500 inspected for contract conformance.`,
        suggestedAction: 'Split the change set or update the architecture contract scope to fit within the inspection budget.',
        safeContext: { totalFiles: changed.length, capped: 500 },
      });
    }

    const explicitlyForbidden = (contract.forbiddenPatterns ?? []).some(
      (p: string) => /DOM island|sidecar|separate/i.test(p),
    );
    const optedIn = isStandaloneOptIn(objective) && !explicitlyForbidden;

    const contentCache = new Map<string, string>();

    try {
      if (!optedIn) {
        issues.push(...detectsParallelDomRoot(cap, contract, contentCache));
        issues.push(...detectsParallelStateStore(cap, contract, contentCache));
      }
      issues.push(...validatesAllowedFiles(cap, contract));
    } catch (err) {
      // Defensive — never break the harness on a detector bug.
      // eslint-disable-next-line no-console
      console.warn('[architecture-reviewer] detector failure:', err);
    }
  }

  return issues;
}
