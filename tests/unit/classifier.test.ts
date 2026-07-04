import { describe, it, expect } from 'vitest';
import { classifyError, parseRetryAfterMs } from '../../src/v2/failover/classifier.js';
import { FailoverError } from '../../src/v2/failover/error.js';

function withStatus(msg: string, status: number): Error {
  const err = new Error(msg);
  (err as unknown as { status: number }).status = status;
  return err;
}

function withStatusAndHeaders(
  msg: string,
  status: number,
  responseHeaders: Record<string, string>,
): Error {
  const err = new Error(msg);
  Object.assign(err, { status, responseHeaders });
  return err;
}

describe('classifyError — Step 1: Provider-specific signatures', () => {
  it('classifies thinking signature mismatch', () => {
    const c = classifyError(new Error('Invalid thinking_signature for block[0]'));
    expect(c.reason).toBe('thinking_signature');
    expect(c.isRetryable).toBe(true);
  });

  it('classifies long context tier refusal', () => {
    const c = classifyError(new Error('This tier does not support 1M context'));
    expect(c.reason).toBe('long_context_tier');
    expect(c.shouldCompress).toBe(true);
  });
});

describe('classifyError — Step 2: HTTP status', () => {
  it('401 without revoked hint → auth (transient)', () => {
    const c = classifyError(withStatus('Unauthorized', 401));
    expect(c.reason).toBe('auth');
    expect(c.isRetryable).toBe(true);
  });

  it('401 with revoked hint → auth_permanent', () => {
    const c = classifyError(withStatus('API key revoked', 401));
    expect(c.reason).toBe('auth_permanent');
    expect(c.isRetryable).toBe(false);
  });

  it('403 without transient hint → auth_permanent', () => {
    const c = classifyError({ status: 403, message: 'Forbidden' });
    expect(c.reason).toBe('auth_permanent');
    expect(c.isRetryable).toBe(false);
  });

  it('403 with "try again" → auth (transient)', () => {
    const c = classifyError(withStatus('Temporary forbid, try again shortly', 403));
    expect(c.reason).toBe('auth');
  });

  it('429 generic → rate_limit', () => {
    const c = classifyError(withStatus('Too many requests', 429));
    expect(c.reason).toBe('rate_limit');
    expect(c.isRetryable).toBe(true);
  });

  it('429 with billing language (no transient) → billing', () => {
    const c = classifyError(withStatus('Quota exceeded — upgrade plan', 429));
    expect(c.reason).toBe('billing');
    expect(c.shouldRotateCredential).toBe(true);
    expect(c.isRetryable).toBe(false);
  });

  it('402 billing final → billing', () => {
    const c = classifyError(withStatus('Payment required: insufficient credits', 402));
    expect(c.reason).toBe('billing');
  });

  it('402 with "try again later" → rate_limit', () => {
    const c = classifyError(withStatus('Quota temporarily exhausted, try again later', 402));
    expect(c.reason).toBe('rate_limit');
  });

  it('503 → overloaded', () => {
    const c = classifyError(withStatus('Service unavailable', 503));
    expect(c.reason).toBe('overloaded');
  });

  it('529 (Anthropic overloaded) → overloaded', () => {
    const c = classifyError(withStatus('Overloaded', 529));
    expect(c.reason).toBe('overloaded');
  });

  it('404 → model_not_found', () => {
    const c = classifyError(withStatus('Model not found', 404));
    expect(c.reason).toBe('model_not_found');
    expect(c.shouldFallback).toBe(true);
  });

  it('413 → payload_too_large', () => {
    const c = classifyError(withStatus('Payload too large', 413));
    expect(c.reason).toBe('payload_too_large');
    expect(c.isRetryable).toBe(false);
  });

  it('408 → timeout', () => {
    const c = classifyError(withStatus('Request timeout', 408));
    expect(c.reason).toBe('timeout');
  });

  it('410 → session_expired', () => {
    const c = classifyError(withStatus('Session gone', 410));
    expect(c.reason).toBe('session_expired');
    expect(c.isRetryable).toBe(true);
  });

  it('500 → server_error', () => {
    const c = classifyError(withStatus('Internal server error', 500));
    expect(c.reason).toBe('server_error');
    expect(c.isRetryable).toBe(true);
  });

  it('502 → server_error', () => {
    const c = classifyError(withStatus('Bad gateway', 502));
    expect(c.reason).toBe('server_error');
  });

  it('504 → server_error', () => {
    const c = classifyError(withStatus('Gateway timeout', 504));
    expect(c.reason).toBe('server_error');
  });

  it('400 generic → format', () => {
    const c = classifyError(withStatus('Invalid request', 400));
    expect(c.reason).toBe('format');
    expect(c.isRetryable).toBe(false);
  });

  it('400 with payload_too_large hint → payload_too_large', () => {
    const c = classifyError(withStatus('Payload too large for endpoint', 400));
    expect(c.reason).toBe('payload_too_large');
  });

  it('400 with context_length_exceeded hint → context_overflow', () => {
    const c = classifyError(withStatus('context_length_exceeded at message 20', 400));
    expect(c.reason).toBe('context_overflow');
    expect(c.shouldCompress).toBe(true);
  });
});

describe('classifyError — Step 3: body error code', () => {
  it('body.error.code=context_length_exceeded → context_overflow', () => {
    const err = Object.assign(new Error('failure'), {
      body: { error: { code: 'context_length_exceeded' } },
    });
    const c = classifyError(err);
    expect(c.reason).toBe('context_overflow');
  });

  it('response.data.error.code=model_not_found → model_not_found', () => {
    const err = Object.assign(new Error('bad'), {
      response: { data: { error: { code: 'model_not_found' } } },
    });
    const c = classifyError(err);
    expect(c.reason).toBe('model_not_found');
  });

  it('error.code=invalid_request_error → format', () => {
    const c = classifyError({ error: { code: 'invalid_request_error' }, message: 'bad' });
    expect(c.reason).toBe('format');
  });

  it('error.code=insufficient_quota → billing', () => {
    const c = classifyError({ error: { code: 'insufficient_quota' }, message: 'billed out' });
    expect(c.reason).toBe('billing');
  });
});

describe('classifyError — Step 4: message patterns', () => {
  it('English "context_length_exceeded" → context_overflow', () => {
    const c = classifyError(new Error('context_length_exceeded limit hit!'));
    expect(c.reason).toBe('context_overflow');
    expect(c.shouldCompress).toBe(true);
  });

  it('English "maximum context length" → context_overflow', () => {
    const c = classifyError(new Error('Request exceeds maximum context length of 200000 tokens'));
    expect(c.reason).toBe('context_overflow');
  });

  it('Chinese 超过最大长度 → context_overflow', () => {
    const c = classifyError(new Error('请求超过最大长度'));
    expect(c.reason).toBe('context_overflow');
  });

  it('Chinese 上下文长度 → context_overflow', () => {
    const c = classifyError(new Error('上下文长度超限'));
    expect(c.reason).toBe('context_overflow');
  });

  it('vLLM "exceeds the max_model_len" → context_overflow', () => {
    const c = classifyError(new Error('This input exceeds the max_model_len of 8192'));
    expect(c.reason).toBe('context_overflow');
  });

  it('Ollama "context length exceeded" → context_overflow', () => {
    const c = classifyError(new Error('context length exceeded (4096)'));
    expect(c.reason).toBe('context_overflow');
  });

  it('prompt injection detection → format', () => {
    const c = classifyError(new Error('Provider detected prompt injection attempt'));
    expect(c.reason).toBe('format');
  });

  it('usage limit with transient → rate_limit', () => {
    const c = classifyError(new Error('Usage limit temporarily reached, please try again later'));
    expect(c.reason).toBe('rate_limit');
  });

  it('usage limit without transient → billing', () => {
    const c = classifyError(new Error('Quota exceeded — upgrade plan to continue'));
    expect(c.reason).toBe('billing');
  });
});

// Example smoke test 2026-04-30 — AETHER α-init bug regression coverage.
// CLI binaries (Codex, Gemini, etc.) emit free-text "Unknown model" stderr
// when handed a foreign provider's model. Before the fix they classified as
// `unknown` (retryable, blind retry) — now they classify as `model_not_found`
// (triggers shouldFallback, model is swapped instead of looped).
describe('classifyError — Step 4.5: model-not-found by stderr message', () => {
  it('Codex-style "Unknown model" → model_not_found', () => {
    const c = classifyError(new Error('Unknown model: claude-sonnet-4-6'));
    expect(c.reason).toBe('model_not_found');
    expect(c.shouldFallback).toBe(true);
  });

  it('"Invalid model" → model_not_found', () => {
    const c = classifyError(new Error('Invalid model name supplied'));
    expect(c.reason).toBe('model_not_found');
  });

  it('"Model not found" → model_not_found', () => {
    const c = classifyError(new Error('error: model not found'));
    expect(c.reason).toBe('model_not_found');
  });

  it('"not a valid model id" (OpenRouter style) → model_not_found', () => {
    const c = classifyError(new Error("'cc/claude-sonnet-4-6' is not a valid model ID"));
    expect(c.reason).toBe('model_not_found');
  });

  it('"model X is not supported" → model_not_found', () => {
    const c = classifyError(new Error('Model gemini-3.1-pro-preview is not supported by this provider'));
    expect(c.reason).toBe('model_not_found');
  });

  it('"unsupported model" → model_not_found', () => {
    const c = classifyError(new Error('unsupported model identifier'));
    expect(c.reason).toBe('model_not_found');
  });

  it('"unrecognized model" → model_not_found', () => {
    const c = classifyError(new Error('Unrecognized model name in request'));
    expect(c.reason).toBe('model_not_found');
  });

  it('plain unfamiliar error stays `unknown`', () => {
    const c = classifyError(new Error('Something went wrong on our end'));
    expect(c.reason).toBe('unknown');
  });
});

describe('classifyError — Step 5: disconnect + large session → context_overflow', () => {
  it('ECONNRESET + large context hint → context_overflow (not timeout)', () => {
    const c = classifyError(new Error('ECONNRESET during large context request'));
    expect(c.reason).toBe('context_overflow');
  });

  it('server disconnect + long conversation → context_overflow', () => {
    const c = classifyError(new Error('server disconnected mid-stream after long conversation'));
    expect(c.reason).toBe('context_overflow');
  });
});

describe('classifyError — Step 6: transport heuristics', () => {
  it('ECONNRESET alone → timeout', () => {
    const c = classifyError(new Error('ECONNRESET connection lost'));
    expect(c.reason).toBe('timeout');
    expect(c.isRetryable).toBe(true);
  });

  it('socket hang up → timeout', () => {
    const c = classifyError(new Error('socket hang up'));
    expect(c.reason).toBe('timeout');
  });

  it('ETIMEDOUT → timeout', () => {
    const c = classifyError(new Error('ETIMEDOUT waiting for response'));
    expect(c.reason).toBe('timeout');
  });

  it('ENETUNREACH → overloaded', () => {
    const c = classifyError(new Error('ENETUNREACH host'));
    expect(c.reason).toBe('overloaded');
  });

  it('ECONNREFUSED → overloaded', () => {
    const c = classifyError(new Error('ECONNREFUSED on port 443'));
    expect(c.reason).toBe('overloaded');
  });
});

describe('classifyError — Step 7: fallback', () => {
  it('totally unknown error → unknown retryable', () => {
    const c = classifyError(new Error('Something cosmic went wrong'));
    expect(c.reason).toBe('unknown');
    expect(c.isRetryable).toBe(true);
  });

  it('string input → unknown', () => {
    const c = classifyError('plain string');
    expect(c.reason).toBe('unknown');
    expect(c.message).toBe('plain string');
  });
});

describe('classifyError — FailoverError passthrough', () => {
  it('re-classifying a FailoverError returns same instance', () => {
    const original = new FailoverError('rate_limit', 'upstream', 429);
    const c = classifyError(original);
    expect(c).toBe(original);
  });

  it('preserves a retryAfterMs carried on a FailoverError', () => {
    const original = new FailoverError('rate_limit', 'upstream', 429, 5_000);
    expect(classifyError(original).retryAfterMs).toBe(5_000);
  });
});

// Aurora-parity Wave-1.5 #1 — parse the HTTP `Retry-After` family of headers.
describe('parseRetryAfterMs', () => {
  const NOW = 1_700_000_000_000; // fixed, whole-second epoch for deterministic dates

  it('parses delta-seconds into milliseconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '30' }, NOW)).toBe(30_000);
  });

  it('parses a zero delta as 0ms', () => {
    expect(parseRetryAfterMs({ 'retry-after': '0' }, NOW)).toBe(0);
  });

  it('parses fractional seconds leniently', () => {
    expect(parseRetryAfterMs({ 'retry-after': '1.5' }, NOW)).toBe(1_500);
  });

  it('prefers the OpenAI-style retry-after-ms header (already milliseconds)', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': '4200' }, NOW)).toBe(4_200);
  });

  it('retry-after-ms takes precedence over retry-after', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': '4200', 'retry-after': '30' }, NOW)).toBe(4_200);
  });

  it('falls through to retry-after when retry-after-ms is garbage / negative', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': 'abc', 'retry-after': '7' }, NOW)).toBe(7_000);
    expect(parseRetryAfterMs({ 'retry-after-ms': '-5', 'retry-after': '7' }, NOW)).toBe(7_000);
  });

  it('parses an HTTP-date into a delta from now', () => {
    const future = new Date(NOW + 60_000).toUTCString();
    expect(parseRetryAfterMs({ 'retry-after': future }, NOW)).toBe(60_000);
  });

  it('clamps a past HTTP-date to 0 (never negative)', () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfterMs({ 'retry-after': past }, NOW)).toBe(0);
  });

  it('returns undefined for unparseable values', () => {
    expect(parseRetryAfterMs({ 'retry-after': 'soon' }, NOW)).toBeUndefined();
  });

  it('returns undefined when the header is absent', () => {
    expect(parseRetryAfterMs({}, NOW)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
  });

  it('rounds a fractional retry-after-ms value', () => {
    expect(parseRetryAfterMs({ 'retry-after-ms': '4200.7' }, NOW)).toBe(4_201);
  });

  it('rejects a non-string (e.g. repeated/array) header value without throwing', () => {
    expect(
      parseRetryAfterMs({ 'retry-after': ['30', '60'] as unknown as string }, NOW),
    ).toBeUndefined();
  });

  it('treats a comma-joined multi-value header as no guidance (does not mis-split a date)', () => {
    // A repeated header flattened to "30, 60" is malformed → undefined (default
    // backoff). Critically, the comma is NOT split — a real HTTP-date also has
    // commas and must still parse.
    expect(parseRetryAfterMs({ 'retry-after': '30, 60' }, NOW)).toBeUndefined();
    const future = new Date(NOW + 90_000).toUTCString(); // contains commas
    expect(parseRetryAfterMs({ 'retry-after': future }, NOW)).toBe(90_000);
  });

  it('parses faithfully (NOT clamped) — the safety ceiling lives downstream', () => {
    const farFuture = new Date(NOW + 200_000).toUTCString();
    expect(parseRetryAfterMs({ 'retry-after': farFuture }, NOW)).toBe(200_000);
    expect(parseRetryAfterMs({ 'retry-after': '999999' }, NOW)).toBe(999_999_000);
  });
});

// Aurora-parity Wave-1.5 #1 — classifyError threads the parsed retry-after onto
// the FailoverError so the executor's backoff can honour the server's window.
describe('classifyError — captures Retry-After from response headers', () => {
  it('429 with retry-after seconds → rate_limit + retryAfterMs', () => {
    const c = classifyError(
      withStatusAndHeaders('Omniroute HTTP 429', 429, { 'retry-after': '30' }),
    );
    expect(c.reason).toBe('rate_limit');
    expect(c.isRetryable).toBe(true);
    expect(c.retryAfterMs).toBe(30_000);
  });

  it('503 with retry-after seconds → overloaded + retryAfterMs', () => {
    const c = classifyError(
      withStatusAndHeaders('Omniroute HTTP 503', 503, { 'retry-after': '12' }),
    );
    expect(c.reason).toBe('overloaded');
    expect(c.retryAfterMs).toBe(12_000);
  });

  it('429 without any retry-after header → rate_limit + undefined retryAfterMs', () => {
    const c = classifyError(withStatus('Omniroute HTTP 429', 429));
    expect(c.reason).toBe('rate_limit');
    expect(c.retryAfterMs).toBeUndefined();
  });

  it('honours a pre-parsed numeric retryAfterMs attached to the error', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 2_500 });
    expect(classifyError(err).retryAfterMs).toBe(2_500);
  });

  it('clamps a pathological header value to the failover ceiling (120s)', () => {
    const c = classifyError(
      withStatusAndHeaders('Omniroute HTTP 429', 429, { 'retry-after': '999999' }),
    );
    expect(c.reason).toBe('rate_limit');
    expect(c.retryAfterMs).toBe(120_000);
  });

  it('clamps a pathological pre-parsed numeric retryAfterMs to the ceiling', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 999_999_999 });
    expect(classifyError(err).retryAfterMs).toBe(120_000);
  });
});

describe('classifyError — flag invariants', () => {
  it('context_overflow sets shouldCompress', () => {
    expect(classifyError(new Error('context_length_exceeded')).shouldCompress).toBe(true);
  });

  it('long_context_tier sets shouldCompress', () => {
    expect(classifyError(new Error('long_context_tier not enabled')).shouldCompress).toBe(true);
  });

  it('model_not_found sets shouldFallback', () => {
    expect(classifyError(withStatus('not found', 404)).shouldFallback).toBe(true);
  });

  it('auth_permanent sets shouldRotateCredential=true + isRetryable=false', () => {
    const c = classifyError(withStatus('Forbidden', 403));
    expect(c.reason).toBe('auth_permanent');
    expect(c.isRetryable).toBe(false);
    expect(c.shouldRotateCredential).toBe(true);
  });

  it('billing sets shouldRotateCredential + non-retryable', () => {
    const c = classifyError(withStatus('insufficient credits', 402));
    expect(c.shouldRotateCredential).toBe(true);
    expect(c.isRetryable).toBe(false);
  });

  it('format non-retryable', () => {
    expect(classifyError(withStatus('bad request', 400)).isRetryable).toBe(false);
  });

  it('payload_too_large non-retryable', () => {
    expect(classifyError(withStatus('too big', 413)).isRetryable).toBe(false);
  });
});
