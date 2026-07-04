// REDACTION_PATTERNS (D-H2.028) — aplicadas ANTES de write no histórico,
// ANTES de stderr em uncaughtException, e ANTES de inclusão no /support-bundle.
//
// Security gate G5 do plano REPL Level D (BLOCKER de ship).

export const REDACTION_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  // GAP-1 fix: anthropic MUST come before openai (sk-ant-* matches both patterns;
  // running openai first replaces the more-specific prefix with the generic one).
  { name: 'anthropic-key',  pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g,        replacement: 'sk-ant-***REDACTED***' },
  { name: 'openai-key',     pattern: /sk-[a-zA-Z0-9_-]{20,}/g,            replacement: 'sk-***REDACTED***' },
  { name: 'bearer-token',   pattern: /Bearer\s+[A-Za-z0-9+/=._-]{20,}/g,  replacement: 'Bearer ***REDACTED***' },
  { name: 'aws-access',     pattern: /AKIA[0-9A-Z]{16}/g,                  replacement: 'AKIA***REDACTED***' },
  { name: 'github-pat',     pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g,       replacement: 'gh*_***REDACTED***' },
  { name: 'slack-bot',      pattern: /xoxb-[A-Za-z0-9-]{20,}/g,           replacement: 'xoxb-***REDACTED***' },
  { name: 'jwt',            pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: 'eyJ***JWT-REDACTED***' },
  { name: 'stripe',         pattern: /(sk|pk|rk)_live_[A-Za-z0-9]+/g,     replacement: '$1_live_***REDACTED***' },
  { name: 'google-api',     pattern: /AIza[0-9A-Za-z\-_]{35}/g,            replacement: 'AIza***REDACTED***' },
  { name: 'connection-str', pattern: /(postgres|mysql|mongodb)(\+srv)?:\/\/[^:]+:[^@]+@/gi, replacement: '$1$2://***:***@' },
  { name: 'private-key',    pattern: /-----BEGIN [A-Z ]+-----/g,           replacement: '-----BEGIN ***REDACTED***-----' },
  { name: 'password-kv',    pattern: /(["']?password["']?\s*[:=]\s*["']?)[^"'\s]+/gi, replacement: '$1***REDACTED***' },
  { name: 'hex-token',      pattern: /\b[a-f0-9]{40,}\b/gi,                replacement: '***HEX-REDACTED***' },
];

/**
 * Apply all REDACTION_PATTERNS to the input string.
 * Order matters: specific prefixes (sk-ant-, xoxb-, AKIA) run before generic
 * hex fallback to avoid double-redacting.
 */
export function redact(input: string): string {
  let out = input;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
