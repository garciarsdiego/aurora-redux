import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

/**
 * Kinds of project the final validation step knows how to check.
 * `other` is returned when a path exists but has no recognised stack marker
 * (e.g. only markdown files) — validation is skipped gracefully.
 */
export type ProjectType = 'typescript' | 'javascript' | 'python' | 'other';

export interface DetectedProject {
  type: ProjectType;
  rootDir: string;
}

/**
 * Extracts the first absolute filesystem path from free-form objective text.
 *
 * Matches Windows (`C:/...`, `C:\...`) and POSIX (`/home/...`) absolute paths.
 * Stops at whitespace, quotes, or typical prose punctuation that would not
 * appear inside a real path.
 *
 * Returns null if no absolute path is found — used as the signal to skip
 * validation for prose/analysis workflows.
 */
export function inferProjectDir(objective: string): string | null {
  // Windows drive-letter paths — allow spaces INSIDE the path (e.g. "Example User")
  // by requiring a trailing separator followed by a boundary char: whitespace,
  // sentence punctuation (. , ; ! ?), quote, angle bracket, or end-of-string.
  // Lazy match keeps us from eating into the next sentence.
  //
  // Found at D35 real run: objective had `...linkedin-extractor-v3/. O projeto`
  // — period after the trailing slash broke the old `(?=\s|$)` lookahead and the
  // POSIX fallback then erroneously matched `/Users/Example`.
  const winPattern = /([A-Za-z]:[\\/].+?[\\/])(?=[\s.,;!?"'<>*]|$)/;
  const winMatch = objective.match(winPattern);
  if (winMatch) {
    return winMatch[1].replace(/[\\/]+$/, '');
  }

  // If the text mentions a Windows drive but our lazy match still failed,
  // treat it as "no valid path" rather than letting the POSIX branch grab
  // a suffix of that Windows path (e.g. `/Users/Example`).
  if (/[A-Za-z]:[\\/]/.test(objective)) return null;

  // POSIX absolute paths — POSIX conventionally has no spaces, so we can stop
  // at the first whitespace or boundary char.
  const posixPattern = /(\/[^\s"'<>|*?\n]+)/;
  const posixMatch = objective.match(posixPattern);
  if (posixMatch) return posixMatch[1].replace(/[,;!?.]$/, '');

  return null;
}

/**
 * Inspects a directory for well-known project markers.
 * Must be called AFTER the workflow runs — the dir is populated by tasks.
 */
export function detectProjectType(rootDir: string): ProjectType | null {
  if (!rootDir || !isAbsolute(rootDir)) return null;
  if (!existsSync(rootDir)) return null;

  const pkgJsonPath = join(rootDir, 'package.json');
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  const requirementsPath = join(rootDir, 'requirements.txt');
  const pyprojectPath = join(rootDir, 'pyproject.toml');

  // TypeScript wins if both package.json and tsconfig.json exist
  if (existsSync(pkgJsonPath) && existsSync(tsconfigPath)) return 'typescript';

  // package.json without tsconfig — treat as JavaScript
  if (existsSync(pkgJsonPath)) {
    // But confirm there actually ARE JS/TS files to validate
    try {
      const pkgRaw = readFileSync(pkgJsonPath, 'utf8');
      const pkg = JSON.parse(pkgRaw) as { type?: string };
      if (pkg.type === 'module' || pkg.type === undefined) return 'javascript';
    } catch {
      // malformed package.json — still a JS-adjacent project, but degrade to 'other'
      return 'other';
    }
    return 'javascript';
  }

  if (existsSync(requirementsPath) || existsSync(pyprojectPath)) return 'python';

  // A directory exists but has nothing we know how to validate
  return 'other';
}

/**
 * Convenience combinator: infer project dir from objective, then detect type.
 * Returns null if either step fails — caller should skip validation.
 */
export function detectProject(objective: string): DetectedProject | null {
  const rootDir = inferProjectDir(objective);
  if (!rootDir) return null;

  const type = detectProjectType(rootDir);
  if (!type) return null;

  return { type, rootDir };
}

/**
 * The shell command to validate a project of the given type. Returns null
 * for `other` — caller skips. Commands assume `cd <rootDir>` has been done.
 *
 * TypeScript command runs `pnpm install` first so `@types/node` and peer
 * deps resolve before `tsc --noEmit`. Uses `npx tsc` to pick up the local
 * typescript from node_modules.
 */
export function getValidationCommand(type: ProjectType): string | null {
  switch (type) {
    case 'typescript':
      return 'pnpm install --silent && npx tsc --noEmit';
    case 'javascript':
      return 'pnpm install --silent && node --check-all';
    case 'python':
      return 'python -m compileall -q .';
    case 'other':
      return null;
  }
}
