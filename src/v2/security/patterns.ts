/**
 * Single source of truth for secret patterns used by every regex-based redactor.
 *
 * Adding a new pattern here automatically extends:
 *   - context redaction (`src/context/redaction.ts`)
 *   - runtime stream-event redaction (`src/runtime/events.ts`)
 *   - workflow debug log redaction (`src/db/workflow-debug-log.ts`)
 *   - secret-scan CI guard (`src/v2/security/secret-scan.ts`, optional opt-in)
 *
 * NOTE: The vault-driven literal-replacement scrubber (`src/v2/security/redact.ts`)
 * is intentionally separate — it scrubs *known* secret values stored in the local
 * vault rather than pattern-matching unknown shapes — so it does not consume
 * this list. It can, however, be combined with `applySecretPatterns()` for
 * defence-in-depth.
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  /** Replacement string passed to `String.prototype.replace`. Defaults to `***REDACTED***`. */
  replacement?: string;
}

const DEFAULT_REPLACEMENT = '***REDACTED***';

export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  {
    name: 'openai_anthropic_key',
    pattern: /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
  },
  {
    name: 'github_pat',
    pattern: /\bghp_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'gitlab_pat',
    pattern: /\bglpat-[A-Za-z0-9_\-]{16,}\b/g,
  },
  {
    name: 'slack_bot',
    pattern: /\bxox[baprs]-[A-Za-z0-9\-]{16,}\b/g,
  },
  {
    name: 'aws_access_key',
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
  },
  {
    name: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._\-~+/=]{16,}/gi,
  },
  {
    name: 'authorization_header',
    pattern: /\bAuthorization:\s*[^\r\n'"]+/gi,
  },
  {
    name: 'cookie_header',
    pattern: /\bCookie:\s*[^\r\n'"]+/gi,
  },
  {
    name: 'database_url',
    pattern: /\b(postgres|postgresql|mysql|mongodb):\/\/[^\s'"]+/gi,
  },
  {
    name: 'api_key_eq',
    pattern: /\b(api[_-]?key|secret|password|token)\s*=\s*['"][^'"\r\n]+['"]/gi,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
  },
  {
    name: 'private_key_block',
    pattern: /-----BEGIN[^-]+PRIVATE KEY-----[\s\S]+?-----END[^-]+PRIVATE KEY-----/g,
  },
]);

/**
 * Apply every SECRET_PATTERN to `text` and return the redacted output.
 *
 * Each pattern uses its own `replacement` (or the default `***REDACTED***`).
 * Patterns are applied sequentially in declaration order; a later pattern can
 * still match if the previous replacement preserved the surrounding text.
 */
export function applySecretPatterns(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement ?? DEFAULT_REPLACEMENT);
  }
  return out;
}

/**
 * Recursively apply `applySecretPatterns` to every string leaf inside `value`.
 *
 * Non-string scalars and `null`/`undefined` pass through untouched. Arrays and
 * plain objects are deep-cloned with redacted leaves so callers can serialize
 * the result without further mutation.
 */
export function applySecretPatternsDeep(value: unknown): unknown {
  if (typeof value === 'string') return applySecretPatterns(value);
  if (Array.isArray(value)) return value.map(applySecretPatternsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = applySecretPatternsDeep(nested);
    }
    return out;
  }
  return value;
}
