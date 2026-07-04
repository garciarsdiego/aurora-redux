export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "context_overflow"
  | "long_context_tier"
  | "payload_too_large"
  | "thinking_signature"
  | "server_error"
  | "unknown";

export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly status?: number;
  readonly isRetryable: boolean;
  readonly shouldCompress: boolean;
  readonly shouldRotateCredential: boolean;
  readonly shouldFallback: boolean;
  /**
   * Server-provided retry window in milliseconds, parsed from the HTTP
   * `Retry-After` (or OpenAI `retry-after-ms`) header when present. The
   * executor's backoff (`selectBackoffMs`) prefers this over the hardcoded
   * per-reason defaults for transient reasons, so a 429/503 waits exactly as
   * long as the provider asked. Undefined when the provider gave no guidance.
   */
  readonly retryAfterMs?: number;

  constructor(reason: FailoverReason, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'FailoverError';
    this.reason = reason;
    this.status = status;
    this.retryAfterMs = retryAfterMs;

    this.shouldCompress =
      reason === 'context_overflow' || reason === 'long_context_tier';
    this.shouldRotateCredential =
      reason === 'auth_permanent' || reason === 'billing';
    this.shouldFallback = reason === 'model_not_found';

    const inherentlyNonRetryable: FailoverReason[] = [
      'auth_permanent',
      'format',
      'payload_too_large',
      'billing',
    ];
    this.isRetryable = !inherentlyNonRetryable.includes(reason);
  }
}
