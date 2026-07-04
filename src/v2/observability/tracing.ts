import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

// Resolved once: the stamped Omniforge version for trace exporters. Mirrors the
// readVersion() lookup in src/mcp/http-server.ts / advisors/version. Previously
// hardcoded '0.3.0' here, which drifted from the real build version.
let cachedVersion: string | null = null;
export function omniforgeVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'version.json'),     // dist/v2/observability → dist/version.json
    resolve(process.cwd(), 'dist', 'version.json'),
    resolve(process.cwd(), 'package.json'),         // dev fallback (tsx, no build)
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const json = JSON.parse(readFileSync(p, 'utf8')) as { version?: string };
      if (json.version) {
        cachedVersion = json.version;
        return cachedVersion;
      }
    } catch {
      // try next candidate
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

export type TraceSpanKind = 'workflow' | 'task' | 'model_call' | 'llm_call' | 'cli_spawn' | 'tool_call' | 'review' | 'hitl' | 'custom';

export interface TraceSpanInput {
  workflowId: string;
  taskId?: string | null;
  parentSpanId?: string | null;
  name: string;
  kind: TraceSpanKind;
  attributes?: Record<string, unknown>;
  now?: number;
}

export interface SpanContext {
  db: Database.Database;
  parentSpanId: string | null;
  workflowId?: string;
}

export const spanContextStorage = new AsyncLocalStorage<SpanContext>();

export interface TraceSpanRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: TraceSpanKind;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  attributes_json: string;
}

export interface ExportedTraceSpan extends Omit<TraceSpanRow, 'attributes_json'> {
  attributes: Record<string, unknown>;
}

/**
 * Sprint 0: Jaeger/Zipkin compatible trace export format
 */
export interface JaegerSpan {
  traceID: string;
  spanID: string;
  parentSpanID?: string;
  operationName: string;
  startTime: number; // microseconds since epoch
  duration: number; // microseconds
  tags: Array<{ key: string; type: string; value: string }>;
  logs: Array<{ timestamp: number; fields: Array<{ key: string; value: string }> }>;
  process: {
    serviceName: string;
    tags: Array<{ key: string; type: string; value: string }>;
  };
}

export function startTraceSpan(db: Database.Database, input: TraceSpanInput): TraceSpanRow {
  const now = input.now ?? Date.now();
  const id = `sp_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO trace_spans
       (id, workflow_id, task_id, parent_span_id, name, kind, status,
        started_at, ended_at, duration_ms, attributes_json)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?)`,
  ).run(
    id,
    input.workflowId,
    input.taskId ?? null,
    input.parentSpanId ?? null,
    input.name,
    input.kind,
    now,
    JSON.stringify(input.attributes ?? {}),
  );
  return db.prepare('SELECT * FROM trace_spans WHERE id = ?').get(id) as TraceSpanRow;
}

export function endTraceSpan(
  db: Database.Database,
  spanId: string,
  input: {
    status: 'ok' | 'error';
    attributes?: Record<string, unknown>;
    now?: number;
  },
): void {
  const row = db.prepare('SELECT started_at, attributes_json FROM trace_spans WHERE id = ?').get(spanId) as
    | { started_at: number; attributes_json: string }
    | undefined;
  if (!row) return;
  const now = input.now ?? Date.now();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(row.attributes_json) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  db.prepare(
    `UPDATE trace_spans
        SET status = ?, ended_at = ?, duration_ms = ?, attributes_json = ?
      WHERE id = ?`,
  ).run(
    input.status,
    now,
    // Clock skew (now < started_at) → 0; otherwise floor to 1ms so consumers
    // can rely on duration > 0 for non-skewed spans even when Windows-grade
    // Date.now() resolution (~15ms) would otherwise round to 0.
    now < row.started_at ? 0 : Math.max(1, now - row.started_at),
    JSON.stringify({ ...existing, ...(input.attributes ?? {}) }),
    spanId,
  );
}

export function exportTraceSpans(
  db: Database.Database,
  workflowId: string,
): ExportedTraceSpan[] {
  const rows = db
    .prepare('SELECT * FROM trace_spans WHERE workflow_id = ? ORDER BY started_at ASC')
    .all(workflowId) as TraceSpanRow[];
  return rows.map((row) => {
    let attributes: Record<string, unknown> = {};
    try {
      attributes = JSON.parse(row.attributes_json) as Record<string, unknown>;
    } catch {
      attributes = {};
    }
    const { attributes_json: _attributesJson, ...rest } = row;
    return { ...rest, attributes };
  });
}

/**
 * Sprint 0: Export traces in Jaeger-compatible format for distributed tracing systems
 */
export function exportTracesJaeger(
  db: Database.Database,
  workflowId: string,
  serviceName: string = 'omniforge-aurora',
): JaegerSpan[] {
  const spans = exportTraceSpans(db, workflowId);
  
  // Convert workflow ID to Jaeger trace ID (16-char hex)
  const traceId = workflowId.replace(/-/g, '').substring(0, 16);
  
  return spans.map((span) => {
    const spanId = span.id.replace(/[^a-f0-9]/g, '').substring(0, 16);
    const parentSpanId = span.parent_span_id?.replace(/[^a-f0-9]/g, '').substring(0, 16);
    
    // Convert attributes to Jaeger tags
    const tags = Object.entries(span.attributes).map(([key, value]) => ({
      key,
      type: typeof value === 'number' ? 'float64' : 'string',
      value: String(value),
    }));
    
    // Add standard tags
    tags.push(
      { key: 'span.kind', type: 'string', value: span.kind },
      { key: 'status', type: 'string', value: span.status },
      { key: 'workflow.id', type: 'string', value: span.workflow_id },
    );
    
    if (span.task_id) {
      tags.push({ key: 'task.id', type: 'string', value: span.task_id });
    }
    
    // Convert to microseconds (Jaeger standard)
    const startTimeMicros = span.started_at * 1000;
    const durationMicros = (span.duration_ms ?? 0) * 1000;
    
    return {
      traceID: traceId,
      spanID: spanId,
      parentSpanID: parentSpanId || undefined,
      operationName: span.name,
      startTime: startTimeMicros,
      duration: durationMicros,
      tags,
      logs: [],
      process: {
        serviceName,
        tags: [
          { key: 'hostname', type: 'string', value: 'localhost' },
          { key: 'omniforge.version', type: 'string', value: omniforgeVersion() },
        ],
      },
    };
  });
}

/**
 * Sprint 0: Export traces in Zipkin v2 format
 */
export interface ZipkinSpan {
  traceId: string;
  id: string;
  parentId?: string;
  name: string;
  timestamp: number; // microseconds since epoch
  duration: number; // microseconds
  localEndpoint: {
    serviceName: string;
    ipv4?: string;
    ipv6?: string;
    port?: number;
  };
  tags?: Record<string, string>;
}

export function exportTracesZipkin(
  db: Database.Database,
  workflowId: string,
  serviceName: string = 'omniforge-aurora',
): ZipkinSpan[] {
  const spans = exportTraceSpans(db, workflowId);
  
  // Convert workflow ID to Zipkin trace ID (16-char hex)
  const traceId = workflowId.replace(/-/g, '').substring(0, 16);
  
  return spans.map((span) => {
    const spanId = span.id.replace(/[^a-f0-9]/g, '').substring(0, 16);
    const parentSpanId = span.parent_span_id?.replace(/[^a-f0-9]/g, '').substring(0, 16);
    
    // Convert attributes to Zipkin tags
    const tags: Record<string, string> = {
      'span.kind': span.kind,
      'status': span.status,
      'workflow.id': span.workflow_id,
    };
    
    if (span.task_id) {
      tags['task.id'] = span.task_id;
    }
    
    // Add custom attributes
    Object.entries(span.attributes).forEach(([key, value]) => {
      tags[key] = String(value);
    });
    
    // Convert to microseconds (Zipkin standard)
    const timestampMicros = span.started_at * 1000;
    const durationMicros = (span.duration_ms ?? 0) * 1000;
    
    return {
      traceId,
      id: spanId,
      parentId: parentSpanId || undefined,
      name: span.name,
      timestamp: timestampMicros,
      duration: durationMicros,
      localEndpoint: {
        serviceName,
        ipv4: '127.0.0.1',
      },
      tags,
    };
  });
}

/**
 * Sprint 0: Get trace statistics for monitoring
 */
export interface TraceStatistics {
  total_spans: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
  p99_duration_ms: number;
  error_count: number;
  error_rate_pct: number;
  by_kind: Record<TraceSpanKind, number>;
}

export function getTraceStatistics(
  db: Database.Database,
  workflowId: string,
): TraceStatistics {
  const spans = exportTraceSpans(db, workflowId);
  
  if (spans.length === 0) {
    return {
      total_spans: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
      p95_duration_ms: 0,
      p99_duration_ms: 0,
      error_count: 0,
      error_rate_pct: 0,
      by_kind: {} as Record<TraceSpanKind, number>,
    };
  }
  
  const durations = spans
    .filter(s => s.duration_ms !== null)
    .map(s => s.duration_ms!)
    .sort((a, b) => a - b);
  
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const avgDuration = totalDuration / durations.length;
  
  const p95Index = Math.floor(durations.length * 0.95);
  const p99Index = Math.floor(durations.length * 0.99);
  const p95Duration = durations[p95Index] ?? 0;
  const p99Duration = durations[p99Index] ?? 0;
  
  const errorCount = spans.filter(s => s.status === 'error').length;
  const errorRate = (errorCount / spans.length) * 100;
  
  const byKind = spans.reduce((acc, span) => {
    acc[span.kind] = (acc[span.kind] || 0) + 1;
    return acc;
  }, {} as Record<TraceSpanKind, number>);
  
  return {
    total_spans: spans.length,
    total_duration_ms: totalDuration,
    avg_duration_ms: Math.round(avgDuration),
    p95_duration_ms: p95Duration,
    p99_duration_ms: p99Duration,
    error_count: errorCount,
    error_rate_pct: Math.round(errorRate * 100) / 100,
    by_kind: byKind,
  };
}

