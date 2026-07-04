/**
 * Filesystem helpers used by Worker.cli_spawn postHook and Reviewer preHook.
 *
 * The reviewer's "filesystem first" rule is implemented here: count lines,
 * verify file exists, check that source files don't accidentally contain
 * markdown (a common failure mode where the worker dumps a narrative summary
 * into a .ts file).
 *
 * Synchronous fs intentionally — agents run in a worker process and these
 * checks must be cheap. If someone needs async later, switch to fs.promises.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { extractFilePathsFromAcceptance } from './tool_trace.js';

export interface FileVerification {
  path: string;
  exists: boolean;
  /** Non-blank line count. -1 when file is missing. */
  lineCount: number;
  /** True when the file's first non-blank line looks like a markdown header
   *  AND the extension is a source-code extension (i.e. the worker described
   *  rather than coded). */
  looksLikeMarkdownInCodeFile: boolean;
  /** Total byte size, 0 when missing. */
  byteSize: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.rs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.sql',
  '.css',
  '.scss',
  '.tf',
  '.sh',
  '.bash',
]);

const SHORT_SUPPLEMENTAL_EVIDENCE_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.out',
]);

export function verifyFile(absolutePath: string): FileVerification {
  if (!existsSync(absolutePath)) {
    return {
      path: absolutePath,
      exists: false,
      lineCount: -1,
      looksLikeMarkdownInCodeFile: false,
      byteSize: 0,
    };
  }
  const content = readFileSync(absolutePath, 'utf-8');
  const stats = statSync(absolutePath);
  const lineCount = content.split('\n').filter((l) => l.trim().length > 0).length;
  const ext = path.extname(absolutePath).toLowerCase();
  const firstLine = content.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const startsWithMd = /^#\s+/.test(firstLine);
  const looksLikeMarkdownInCodeFile = startsWithMd && SOURCE_EXTENSIONS.has(ext);
  return {
    path: absolutePath,
    exists: true,
    lineCount,
    looksLikeMarkdownInCodeFile,
    byteSize: stats.size,
  };
}

const LOCAL_REEXPORT_RE = /^\s*export\s+(?:\{[^}]+\}|\*)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
const SOURCE_RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

function isHealthySourceFile(v: FileVerification): boolean {
  return v.exists && v.lineCount >= 5 && !v.looksLikeMarkdownInCodeFile;
}

function resolveSourceCandidate(basePath: string): string | null {
  for (const suffix of SOURCE_RESOLUTION_SUFFIXES) {
    const candidate = `${basePath}${suffix}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function verifyLocalReExportTarget(
  absolutePath: string,
  seen = new Set<string>(),
): { targetPath: string; verification: FileVerification } | null {
  if (seen.has(absolutePath) || !existsSync(absolutePath)) return null;
  seen.add(absolutePath);

  const content = readFileSync(absolutePath, 'utf-8');
  const nonBlankLines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  if (nonBlankLines.length > 3) return null;

  const match = LOCAL_REEXPORT_RE.exec(nonBlankLines.join('\n'));
  const specifier = match?.[1];
  if (!specifier || !specifier.startsWith('.')) return null;

  const targetBase = path.resolve(path.dirname(absolutePath), specifier);
  const targetPath = resolveSourceCandidate(targetBase);
  if (!targetPath || seen.has(targetPath)) return null;

  const targetVerification = verifyFile(targetPath);
  if (isHealthySourceFile(targetVerification)) {
    return { targetPath, verification: targetVerification };
  }

  if (targetVerification.exists && targetVerification.lineCount < 5) {
    return verifyLocalReExportTarget(targetPath, seen);
  }
  return null;
}

function candidateBaseDirs(candidates: readonly string[]): string[] {
  const dirs = candidates
    .filter((candidate) => !path.isAbsolute(candidate))
    .filter((candidate) => !candidate.startsWith('./') && !candidate.startsWith('../'))
    .map((candidate) => path.posix.dirname(candidate.replace(/\\/g, '/')))
    .filter((dir) => dir !== '.');
  return Array.from(new Set(dirs));
}

function resolveAcceptancePath(
  workspaceDir: string,
  rel: string,
  baseDirs: readonly string[],
): { abs: string; evidencePath: string } {
  const directAbs = path.isAbsolute(rel) ? rel : path.resolve(workspaceDir, rel);
  if (path.isAbsolute(rel) || existsSync(directAbs) || !rel.startsWith('./')) {
    return { abs: directAbs, evidencePath: rel };
  }

  for (const baseDir of baseDirs) {
    const candidateEvidence = path.posix.normalize(`${baseDir}/${rel.slice(2)}`);
    const candidateAbs = path.resolve(workspaceDir, candidateEvidence);
    if (existsSync(candidateAbs)) {
      return { abs: candidateAbs, evidencePath: candidateEvidence };
    }
  }

  return { abs: directAbs, evidencePath: rel };
}

function displayEvidencePath(workspaceDir: string, evidencePath: string): string {
  if (!path.isAbsolute(evidencePath)) return evidencePath;
  const relative = path.relative(workspaceDir, evidencePath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return evidencePath.replace(/\\/g, '/');
}

function isShortSupplementalEvidenceFile(candidate: string, v: FileVerification, isSupplementalOnly: boolean): boolean {
  if (!isSupplementalOnly || !v.exists || v.lineCount <= 0) return false;
  const ext = path.extname(candidate).toLowerCase();
  return SHORT_SUPPLEMENTAL_EVIDENCE_EXTENSIONS.has(ext) && !SOURCE_EXTENSIONS.has(ext);
}

export interface AcceptanceVerification {
  /** True when filesystem alone proves pass/fail. False ⇒ reviewer should LLM. */
  canDecide: boolean;
  verdict: 'pass' | 'fail';
  feedback: string;
  evidence: { criterion: string; status: 'met' | 'unmet' | 'ambiguous'; proof: string }[];
  summary: {
    files_verified: string[];
    files_missing: string[];
    files_too_short: string[];
  };
}

/**
 * Best-effort filesystem check for an acceptance string.
 *
 * - Extracts referenced file paths.
 * - For each: if missing → fail; if too short (< 5 lines) → fail; if markdown
 *   in source extension → fail.
 * - If all referenced files exist with healthy content AND the acceptance
 *   string only mentioned existence/line-count properties, returns pass.
 * - Otherwise returns canDecide=false so the reviewer LLM gets called for
 *   semantic checks (export name, prop shape, etc.).
 */
export function verifyAcceptanceArtifacts(
  acceptanceCriteria: string | null | undefined,
  workspaceDir: string,
  supplementalPaths: readonly string[] = [],
): AcceptanceVerification {
  const summary = { files_verified: [] as string[], files_missing: [] as string[], files_too_short: [] as string[] };
  const evidence: AcceptanceVerification['evidence'] = [];
  if (!acceptanceCriteria && supplementalPaths.length === 0) {
    return { canDecide: false, verdict: 'pass', feedback: '', evidence, summary };
  }

  const acceptanceCandidates = extractFilePathsFromAcceptance(acceptanceCriteria ?? '');
  const supplementalCandidates = supplementalPaths.filter((candidate) => candidate.trim().length > 0);
  const acceptanceCandidateSet = new Set(acceptanceCandidates);
  const supplementalCandidateSet = new Set(supplementalCandidates);
  const candidates = Array.from(new Set([
    ...acceptanceCandidates,
    ...supplementalCandidates,
  ]));
  if (candidates.length === 0) {
    return { canDecide: false, verdict: 'pass', feedback: '', evidence, summary };
  }

  let failure = false;
  const failureReasons: string[] = [];
  const baseDirs = candidateBaseDirs(candidates);

  for (const rel of candidates) {
    const { abs, evidencePath } = resolveAcceptancePath(workspaceDir, rel, baseDirs);
    const v = verifyFile(abs);
    const displayPath = displayEvidencePath(workspaceDir, evidencePath);
    const isSupplementalOnly = supplementalCandidateSet.has(rel) && !acceptanceCandidateSet.has(rel);
    if (!v.exists) {
      summary.files_missing.push(evidencePath);
      evidence.push({ criterion: evidencePath, status: 'unmet', proof: `File ${evidencePath} does not exist on filesystem.` });
      failureReasons.push(`Missing: ${evidencePath}`);
      failure = true;
      continue;
    }
    if (v.lineCount < 5) {
      if (isShortSupplementalEvidenceFile(evidencePath, v, isSupplementalOnly)) {
        summary.files_verified.push(displayPath);
        evidence.push({
          criterion: displayPath,
          status: 'met',
          proof: `${displayPath} exists as supplemental command-output evidence with ${v.lineCount} non-blank lines.`,
        });
        continue;
      }
      const reExportTarget = verifyLocalReExportTarget(abs);
      if (reExportTarget) {
        summary.files_verified.push(displayPath);
        const targetRel = path.relative(workspaceDir, reExportTarget.targetPath).replace(/\\/g, '/');
        evidence.push({
          criterion: displayPath,
          status: 'met',
          proof: `${evidencePath} is a local barrel export to ${targetRel}, which exists with ${reExportTarget.verification.lineCount} non-blank lines.`,
        });
        continue;
      }
      summary.files_too_short.push(evidencePath);
      evidence.push({ criterion: evidencePath, status: 'unmet', proof: `${evidencePath} has ${v.lineCount} non-blank lines (< 5).` });
      failureReasons.push(`Too short: ${evidencePath} (${v.lineCount} lines)`);
      failure = true;
      continue;
    }
    if (v.looksLikeMarkdownInCodeFile) {
      evidence.push({ criterion: evidencePath, status: 'unmet', proof: `${evidencePath} starts with markdown header but extension is source code.` });
      failureReasons.push(`Markdown-in-code: ${evidencePath}`);
      failure = true;
      continue;
    }
    summary.files_verified.push(displayPath);
    evidence.push({ criterion: displayPath, status: 'met', proof: `${displayPath} exists, ${v.lineCount} non-blank lines.` });
  }

  // Heuristic: if acceptance only mentions existence + line counts, fs check is
  // conclusive. Semantic words (export name, prop shape, behavior) require LLM.
  const semanticRe = /\b(export(s|ed)?|prop|interface|type|behavior|return|render|test|pass|emit|callback)\b/i;
  const semanticPresent = semanticRe.test(acceptanceCriteria ?? '');

  if (failure) {
    return {
      canDecide: true,
      verdict: 'fail',
      feedback: `Filesystem check failed: ${failureReasons.join('; ')}`,
      evidence,
      summary,
    };
  }
  if (!semanticPresent) {
    return {
      canDecide: true,
      verdict: 'pass',
      feedback: `Filesystem check passed: ${summary.files_verified.length} file(s) present with healthy content.`,
      evidence,
      summary,
    };
  }

  return { canDecide: false, verdict: 'pass', feedback: '', evidence, summary };
}
