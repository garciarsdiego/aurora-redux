import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { SECRET_PATTERNS } from './patterns.js';

export interface SecretFinding {
  filePath: string;
  line: number;
  column: number;
  ruleId: string;
  redacted: string;
}

export interface SecretScanOptions {
  excludeDirs?: string[];
  excludeFiles?: string[];
  maxFileBytes?: number;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
  /** When true, drop a generic finding if a named-env rule already fired on the same line. */
  dedupeWhenNamed?: boolean;
}

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'data',
  '.tmp',
  'tmp',
  'workspaces',
  '_artifacts',
  'fixtures',
]);

const DEFAULT_EXCLUDED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  'daemon-token.txt',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.cmd',
  '.csv',
  '.env',
  '.example',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.md',
  '.ps1',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const NAMED_ENV_RULES: SecretRule[] = [
  {
    id: 'omniroute-api-key',
    pattern: /\bOMNIROUTE_API_KEY\b\s*[:=]\s*['"]?(sk-[A-Za-z0-9][A-Za-z0-9_-]{20,})/g,
  },
  {
    id: 'telegram-bot-token',
    pattern: /\bTELEGRAM_BOT_TOKEN\b\s*[:=]\s*['"]?(\d{6,}:[A-Za-z0-9_-]{25,})/g,
  },
  {
    id: 'slack-webhook-url',
    pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,})/g,
  },
];

/**
 * Generic shape rules sourced from the canonical SECRET_PATTERNS.
 *
 * Only the patterns whose match value is meaningful as a captured secret are
 * lifted (private keys, JWTs, AWS keys, raw GitHub/GitLab/Slack tokens, etc.).
 * Header- or env-line patterns whose primary value is human-readable
 * substitution (Authorization:, Cookie:, Bearer X) are intentionally excluded
 * — they would produce noisy false positives when scanning committed source.
 *
 * `dedupeWhenNamed: true` causes a generic finding to be dropped if a named-env
 * rule already fired on the same line. This keeps the existing 3-rule contract
 * for `OMNIROUTE_API_KEY` / `TELEGRAM_BOT_TOKEN` / `slack-webhook-url`
 * exclusive while still catching naked secrets elsewhere.
 */
const GENERIC_SHAPE_RULE_NAMES = new Set([
  'openai_anthropic_key',
  'github_pat',
  'gitlab_pat',
  'slack_bot',
  'aws_access_key',
  'jwt',
  'private_key_block',
]);

const GENERIC_SHAPE_RULES: SecretRule[] = SECRET_PATTERNS
  .filter((p) => GENERIC_SHAPE_RULE_NAMES.has(p.name))
  .map((p) => ({
    id: `generic-${p.name.replace(/_/g, '-')}`,
    // Wrap the pattern in a capture group so the secret value can be reported
    // through the same `match[1]` extraction pipeline used by named-env rules.
    pattern: new RegExp(`(${p.pattern.source})`, p.pattern.flags),
    dedupeWhenNamed: true,
  }));

const SECRET_RULES: SecretRule[] = [...NAMED_ENV_RULES, ...GENERIC_SHAPE_RULES];

const PLACEHOLDER_VALUES = new Set([
  '',
  'CHANGE_ME',
  'SUA_KEY_AQUI',
  'YOUR_KEY_HERE',
  '<OMNIROUTE_API_KEY>',
  '[REDACTED_OMNIROUTE_API_KEY]',
  '[REDACTED_TELEGRAM_BOT_TOKEN]',
]);

/**
 * Paths whose generic-shape findings are intentionally suppressed.
 * These contain test fixtures, audit evidence, or documentation that
 * embeds example secrets for assertion/illustration purposes. Named-env
 * rules still apply everywhere so committed *real* `OMNIROUTE_API_KEY` /
 * `TELEGRAM_BOT_TOKEN` / Slack webhook values still trip.
 *
 * Markdown files (`.md`) are also suppressed — docs frequently illustrate
 * secret shapes and audit reports cite leaked examples by value. Real
 * secrets in code paths are still caught.
 */
const GENERIC_SUPPRESSED_PATH_PATTERN = /(^|[\\/])(tests?|__tests__|fixtures|_artifacts|docs)([\\/]|$)|\.md$|[\\/]_smoke_/i;

export function scanTextForSecrets(text: string, filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const namedLines = new Set<number>();
  const seen = new Set<string>();
  const suppressGeneric = GENERIC_SUPPRESSED_PATH_PATTERN.test(filePath);

  for (const rule of SECRET_RULES) {
    if (suppressGeneric && rule.dedupeWhenNamed) continue;
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const secret = match[1] ?? '';
      if (isPlaceholder(secret)) continue;
      const position = getLineColumn(text, match.index ?? 0);

      if (rule.dedupeWhenNamed && namedLines.has(position.line)) continue;

      const key = `${position.line}:${position.column}:${rule.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        filePath,
        line: position.line,
        column: position.column,
        ruleId: rule.id,
        redacted: redactSecret(secret),
      });

      if (!rule.dedupeWhenNamed) namedLines.add(position.line);
    }
  }
  return findings.sort((a, b) =>
    a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column,
  );
}

export function scanDirectory(rootDir: string, options: SecretScanOptions = {}): SecretFinding[] {
  const excludedDirs = new Set([...DEFAULT_EXCLUDED_DIRS, ...(options.excludeDirs ?? [])]);
  const excludedFiles = new Set([...DEFAULT_EXCLUDED_FILES, ...(options.excludeFiles ?? [])]);
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const findings: SecretFinding[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(entry.name, excludedFiles)) continue;

      const stat = statSync(absPath);
      if (stat.size > maxFileBytes || !looksTextLike(entry.name)) continue;

      const content = readFileSync(absPath, 'utf8');
      if (content.includes('\0')) continue;
      const relPath = relative(rootDir, absPath).replace(/\\/g, '/');
      findings.push(...scanTextForSecrets(content, relPath));
    }
  }

  walk(rootDir);
  return findings.sort((a, b) =>
    a.filePath.localeCompare(b.filePath) || a.line - b.line || a.column - b.column,
  );
}

// Re-export so callers can import the redactor alongside the scanner.
export { applySecretPatterns, applySecretPatternsDeep } from './patterns.js';

export function formatSecretFindings(findings: SecretFinding[]): string {
  if (findings.length === 0) return 'No committed secrets detected.';
  return findings
    .map((finding) =>
      `${finding.filePath}:${finding.line}:${finding.column} ${finding.ruleId} ${finding.redacted}`,
    )
    .join('\n');
}

function shouldSkipFile(fileName: string, excludedFiles: Set<string>): boolean {
  if (excludedFiles.has(fileName)) return true;
  return fileName.startsWith('.env.') && fileName !== '.env.example';
}

function looksTextLike(fileName: string): boolean {
  if (fileName === 'Dockerfile' || fileName.endsWith('Dockerfile')) return true;
  return TEXT_EXTENSIONS.has(extname(fileName).toLowerCase()) || TEXT_EXTENSIONS.has(basename(fileName));
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.trim()) || /^\[REDACTED_[A-Z0-9_]+\]$/.test(value.trim());
}

function redactSecret(value: string): string {
  if (value.length <= 8) return '[REDACTED]';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function getLineColumn(text: string, offset: number): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}
