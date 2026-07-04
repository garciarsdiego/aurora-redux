import { SECRET_PATTERNS } from '../v2/security/patterns.js';

/**
 * Context-layer redaction patterns.
 *
 * These patterns produce *human-readable* replacements (e.g. `Bearer ***`,
 * `DATABASE_URL=***`, `$1=***` with named captures) so context bodies stay
 * useful for debugging. They are applied FIRST. A filtered subset of the
 * canonical `SECRET_PATTERNS` from `src/v2/security/patterns.ts` is then
 * applied as a defence-in-depth pass to catch *additional* shapes (JWT,
 * private-key blocks, naked AWS/GitHub/GitLab tokens) that the context
 * patterns above don't already handle. Patterns whose canonical version would
 * clobber a context-specific replacement (Bearer, Authorization, Cookie,
 * DATABASE_URL, api_key_eq) are excluded from the second pass.
 */
const CONTEXT_CONFLICTING_GENERIC_PATTERNS = new Set([
  'bearer_token',
  'authorization_header',
  'cookie_header',
  'database_url',
  'api_key_eq',
]);

const CONTEXT_GENERIC_PATTERNS = SECRET_PATTERNS.filter(
  (entry) => !CONTEXT_CONFLICTING_GENERIC_PATTERNS.has(entry.name),
);

function applyContextGenericPatterns(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replacement } of CONTEXT_GENERIC_PATTERNS) {
    out = out.replace(pattern, replacement ?? '***REDACTED***');
  }
  return out;
}
const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***'],
  [/\bmcp-[A-Za-z0-9_-]{8,}\b/g, 'mcp-***'],
  [/\b(?:ghp|github_pat|glpat|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/g, '***REDACTED***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***REDACTED***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}\b/gi, 'Bearer ***'],
  [/\bAuthorization:\s*Basic\s+[A-Za-z0-9+/=-]+/gi, 'Authorization: Basic ***'],
  [/\bCookie:\s*[^\r\n]+/gi, 'Cookie: ***'],
  [/\bDATABASE_URL\s*=\s*["']?[^"'\s]+/gi, 'DATABASE_URL=***'],
  [/\b[A-Z0-9_]*DATABASE_URL\s*=\s*["']?[^"'\s]+/gi, 'DATABASE_URL=***'],
  [/\b(postgres(?:ql)?:\/\/)[^\s"'@]+:[^\s"'@]+@/gi, '$1***:***@'],
  [/\b(password|passwd|pwd)\s*[:=]\s*["']?[^"'\r\n]+/gi, '$1=***'],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|credential)\b\s*[:=]\s*["']?[^"',;\s]+/gi,
    '$1=***',
  ],
  [
    /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|OMNIROUTE_API_KEY|LOVABLE_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*["']?[^"'\s]+/gi,
    '$1=***',
  ],
];

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|bearer|credential)/i;

export function redactContextText(input: string): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return applyContextGenericPatterns(output);
}

export function redactContextBody(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(redactContextJson(JSON.parse(trimmed) as unknown));
    } catch {
      // Fall through to regex redaction for non-JSON text.
    }
  }
  return redactContextText(input);
}

export function redactContextJson<T>(value: T): T {
  return redactJsonValue(value, '') as T;
}

function redactJsonValue(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY_PATTERN.test(key)) {
      if (/^Bearer\s+/i.test(value)) return 'Bearer ***';
      return '***';
    }
    return redactContextText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, key));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = redactJsonValue(entryValue, entryKey);
    }
    return output;
  }
  return value;
}
