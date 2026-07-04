// Daemon HTTP/SSE client (D-H2.025 + D-H2.027).
//
// Functions:
//   - healthCheck(timeoutMs): GET /health (no auth) — decides mode at boot
//   - registerActor(): POST /actor/register → {actor_id, actor_token, expires_at}
//   - subscribeWorkflowEvents(wfId, sinceEventId): SSE GET /events/workflow/:id
//   - subscribeGates(workspace): SSE GET /events/gates?workspace=X
//   - cancelWorkflow(wfId): POST /workflow/:id/cancel
//   - resolveGate(gateId, decision): POST /gate/:id/resolve → {first_resolver}
//   - streamLLM(prompt, model): SSE POST /stream/llm
//
// Token resolution: env OMNIFORGE_DAEMON_TOKEN > data/daemon-token.txt.
// 401 → re-read file → retry 1× → error.
// Implementation phase: MA (healthCheck) → MD (all).

import { DAEMON_PORT, DAEMON_HEALTH_TIMEOUT_MS } from '../config.js';

export interface DaemonHealth {
  readonly status: string;
  readonly version: string;
  readonly uptime_ms: number;
  readonly api_version: number;
}

export async function healthCheck(timeoutMs = DAEMON_HEALTH_TIMEOUT_MS): Promise<DaemonHealth | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as DaemonHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
