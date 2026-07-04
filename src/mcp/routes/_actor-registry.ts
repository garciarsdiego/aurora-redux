// Sprint 4.7 (D-H2.066): in-memory actor token registry.
//
// Shared between actor router (register/heartbeat/unregister + gate resolve)
// and SSE router (LLM stream rate limiting per actor). REPL/Hermes/external
// clients register to receive an opaque actor_token used for race-safe gate
// resolution and stream rate-limiting. Tokens live in memory only; daemon
// restart invalidates them (clients re-register on reconnect). TTL 1h with
// heartbeat renew.

import { randomBytes } from 'node:crypto';
import { constantTimeTokenCompare } from './_shared.js';

export const ACTOR_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
export const MAX_LLM_STREAMS_PER_ACTOR = 4;

export interface ActorEntry {
  actor_id: string;
  kind: 'repl' | 'cli' | 'external';
  expires_at: number;
}

export interface ActorAuth {
  actor_id: string;
  actor_token: string;
}

export const actorRegistry = new Map<string, ActorEntry>();
export const llmStreamsByActor = new Map<string, number>();

export function isExpired(entry: ActorEntry): boolean {
  return entry.expires_at < Date.now();
}

export function pruneExpiredActors(): void {
  const now = Date.now();
  for (const [token, entry] of actorRegistry) {
    if (entry.expires_at < now) actorRegistry.delete(token);
  }
}

export function generateActorId(kind: ActorEntry['kind']): string {
  return `${kind}-${randomBytes(6).toString('hex')}`;
}

export function generateActorToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A11 — constant-time actor-token lookup.
 *
 * The naive `actorRegistry.get(actorToken)` performs O(1) hash lookup, which
 * leaks a microsecond-scale timing signal correlated with V8 hash bucket
 * occupancy. For 127.0.0.1 self-loop this is below practical exploit, but
 * the daemon also serves SSE to external clients via the same surface; an
 * adversary with local-network sniffing could (in theory) infer prefix
 * collisions across tokens.
 *
 * Mitigation: iterate the registry, comparing each stored token with
 * `timingSafeEqual` (fixed-length byte compare). O(n) is acceptable for the
 * single-operator workload (<10 actors).
 */
export function requireActorToken(actorToken: string | undefined): ActorAuth | null {
  if (!actorToken || typeof actorToken !== 'string') return null;
  pruneExpiredActors();
  for (const [storedToken, entry] of actorRegistry.entries()) {
    if (constantTimeTokenCompare(actorToken, storedToken)) {
      if (isExpired(entry)) return null;
      return { actor_id: entry.actor_id, actor_token: storedToken };
    }
  }
  return null;
}
