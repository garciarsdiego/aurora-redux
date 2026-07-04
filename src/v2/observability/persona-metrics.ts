/**
 * Persona-vs-legacy invocation metrics (audit §13 P2 #18).
 *
 * Aggregates the existing `agent_started` / `agent_completed` /
 * `agent_rejected` events (emitted by `runAgent` in src/v2/agents/runner.ts)
 * to surface "is the persona path actually running, and how is it doing?"
 * Operators flip OMNIFORGE_USE_PERSONAS=true and want to know:
 *   - How often did each persona engage vs. fall back to legacy?
 *   - What's the average latency per persona?
 *   - What's the rejection rate per persona?
 *   - Are cache_read_input_tokens > 0 (B6.1 working)?
 *
 * Pure read query — no side effects, no event emission. Computed on demand
 * from the events + trace_spans tables.
 */

import type Database from 'better-sqlite3';
import type { AgentId } from '../agents/types.js';

export interface PersonaInvocationStats {
  agent_id: AgentId | string;
  total_started: number;
  total_completed: number;
  total_rejected: number;
  total_short_circuited: number;
  /** ms — only populated when trace_spans for this agent are present */
  avg_latency_ms: number | null;
  /** ms — p95 */
  p95_latency_ms: number | null;
  /**
   * Sum of cache_read_input_tokens across runs for this persona's LLM
   * calls. Non-null and > 0 = the B6.1 prompt-prefix cache is taking
   * effect on at least some calls.
   */
  total_cache_read_tokens: number | null;
}

export interface PersonaMetricsQuery {
  /** When set, restrict to this workflow id only. Default: all workflows. */
  workflowId?: string;
  /** When set, only events newer than this epoch ms. Default: no filter. */
  sinceMs?: number;
  /** Optional explicit list of agent ids; defaults to all observed. */
  agentIds?: readonly string[];
}

interface EventRow {
  payload_json: string | null;
}

interface SpanRow {
  attributes_json: string | null;
  ended_at: number | null;
  started_at: number;
}

function readAgentIdFromEvent(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const p = JSON.parse(payloadJson) as { agent_id?: unknown };
    return typeof p.agent_id === 'string' ? p.agent_id : null;
  } catch {
    return null;
  }
}

function readShortCircuitFromEvent(payloadJson: string | null): boolean {
  if (!payloadJson) return false;
  try {
    const p = JSON.parse(payloadJson) as { short_circuited?: unknown };
    return p.short_circuited === true;
  } catch {
    return false;
  }
}

function readSpanLatencyMs(span: SpanRow): number | null {
  if (span.ended_at == null) return null;
  return span.ended_at - span.started_at;
}

function readSpanCacheReadTokens(attributesJson: string | null): number | null {
  if (!attributesJson) return null;
  try {
    const a = JSON.parse(attributesJson) as { cache_read_input_tokens?: unknown };
    return typeof a.cache_read_input_tokens === 'number' ? a.cache_read_input_tokens : null;
  } catch {
    return null;
  }
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

/**
 * Returns one row per agent_id observed. Empty array when no agent events
 * exist (e.g. flag never flipped on, fresh DB).
 */
export function getPersonaMetrics(
  db: Database.Database,
  query: PersonaMetricsQuery = {},
): PersonaInvocationStats[] {
  const where: string[] = ["type IN ('agent_started','agent_completed','agent_rejected')"];
  const params: Record<string, unknown> = {};
  if (query.workflowId) {
    where.push('workflow_id = $wfId');
    params['wfId'] = query.workflowId;
  }
  if (query.sinceMs != null) {
    where.push('timestamp >= $since');
    params['since'] = query.sinceMs;
  }
  const eventSql = `
    SELECT type, payload_json
    FROM events
    WHERE ${where.join(' AND ')}
  `;
  const rows = db.prepare(eventSql).all(params) as Array<{ type: string; payload_json: string | null }>;

  const counters = new Map<string, {
    started: number;
    completed: number;
    rejected: number;
    short_circuited: number;
  }>();

  for (const row of rows) {
    const agentId = readAgentIdFromEvent(row.payload_json);
    if (!agentId) continue;
    if (query.agentIds && !query.agentIds.includes(agentId)) continue;
    const c = counters.get(agentId) ?? { started: 0, completed: 0, rejected: 0, short_circuited: 0 };
    if (row.type === 'agent_started') c.started++;
    else if (row.type === 'agent_completed') {
      c.completed++;
      if (readShortCircuitFromEvent(row.payload_json)) c.short_circuited++;
    } else if (row.type === 'agent_rejected') c.rejected++;
    counters.set(agentId, c);
  }

  // Latency + cache aggregation from trace_spans (kind='llm_call'). The span's
  // name embeds the model id but the workflow_id ties it to the same task —
  // we don't attempt to attribute a span back to a SPECIFIC agent invocation
  // here (it would require span hierarchy walking). We instead aggregate per
  // workflow → for now this means latency/cache are workflow-level not
  // per-persona. Operators tend to care about "is the wire alive" more than
  // "exactly which persona was slow", so this is a deliberate simplification.
  const latencyByWf = new Map<string, number[]>();
  const cacheReadByWf = new Map<string, number>();
  if (query.workflowId || query.sinceMs != null) {
    const spanWhere: string[] = ["kind = 'llm_call'"];
    const spanParams: Record<string, unknown> = {};
    if (query.workflowId) {
      spanWhere.push('workflow_id = $wfId');
      spanParams['wfId'] = query.workflowId;
    }
    if (query.sinceMs != null) {
      spanWhere.push('started_at >= $since');
      spanParams['since'] = query.sinceMs;
    }
    const spanSql = `
      SELECT workflow_id, started_at, ended_at, attributes_json
      FROM trace_spans
      WHERE ${spanWhere.join(' AND ')}
    `;
    let spans: Array<SpanRow & { workflow_id: string }> = [];
    try {
      spans = db.prepare(spanSql).all(spanParams) as Array<SpanRow & { workflow_id: string }>;
    } catch {
      // trace_spans table may not exist yet on legacy schemas — silently skip
      spans = [];
    }
    for (const span of spans) {
      const lat = readSpanLatencyMs(span);
      if (lat != null) {
        const arr = latencyByWf.get(span.workflow_id) ?? [];
        arr.push(lat);
        latencyByWf.set(span.workflow_id, arr);
      }
      const cache = readSpanCacheReadTokens(span.attributes_json);
      if (cache != null && cache > 0) {
        cacheReadByWf.set(span.workflow_id, (cacheReadByWf.get(span.workflow_id) ?? 0) + cache);
      }
    }
  }

  // Aggregate latency / cache across ALL observed wfs (or the single one).
  const allLatencies = Array.from(latencyByWf.values()).flat();
  const totalCacheRead = Array.from(cacheReadByWf.values()).reduce((a, b) => a + b, 0);
  const avgLatency = allLatencies.length === 0 ? null : Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length);
  const p95Latency = p95(allLatencies);

  const result: PersonaInvocationStats[] = [];
  for (const [agentId, c] of counters) {
    result.push({
      agent_id: agentId as PersonaInvocationStats['agent_id'],
      total_started: c.started,
      total_completed: c.completed,
      total_rejected: c.rejected,
      total_short_circuited: c.short_circuited,
      avg_latency_ms: avgLatency,
      p95_latency_ms: p95Latency,
      total_cache_read_tokens: totalCacheRead === 0 ? null : totalCacheRead,
    });
  }

  // Sort by total invocations desc — most-active personas first
  result.sort((a, b) => (b.total_started + b.total_rejected) - (a.total_started + a.total_rejected));
  return result;
}

export interface PersonaVsLegacyShare {
  /** Number of workflows observed in the window. */
  workflows_total: number;
  /** Workflows where ANY agent_started event was emitted (= persona path engaged). */
  workflows_with_persona_path: number;
  /** Pct (0..100). */
  persona_path_share_pct: number;
}

/**
 * Quick "did anyone use the persona path?" answer. Useful for the dashboard
 * card that surfaces feature-flag rollout state at a glance.
 */
export function getPersonaVsLegacyShare(
  db: Database.Database,
  sinceMs?: number,
): PersonaVsLegacyShare {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (sinceMs != null) {
    where.push('created_at >= $since');
    params['since'] = sinceMs;
  }
  const wfSql = `SELECT id FROM workflows ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}`;
  const wfRows = db.prepare(wfSql).all(params) as Array<{ id: string }>;
  if (wfRows.length === 0) {
    return { workflows_total: 0, workflows_with_persona_path: 0, persona_path_share_pct: 0 };
  }
  const ids = wfRows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `$id${i}`).join(',');
  const eventParams: Record<string, unknown> = {};
  ids.forEach((id, i) => { eventParams[`id${i}`] = id; });
  const eventSql = `
    SELECT DISTINCT workflow_id FROM events
    WHERE type = 'agent_started' AND workflow_id IN (${placeholders})
  `;
  const eventRows = db.prepare(eventSql).all(eventParams) as Array<{ workflow_id: string }>;
  const withPersona = eventRows.length;
  const total = wfRows.length;
  return {
    workflows_total: total,
    workflows_with_persona_path: withPersona,
    persona_path_share_pct: total === 0 ? 0 : Math.round((withPersona / total) * 100),
  };
}
