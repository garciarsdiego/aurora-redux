import type Database from 'better-sqlite3';
import { redactSecrets } from '../v2/security/redact.js';
import { applySecretPatterns } from '../v2/security/patterns.js';
import { redactContextJson, redactContextText } from '../context/redaction.js';
import { listRuntimeExecutorCapabilities } from '../runtime/capabilities.js';

export interface WorkflowDebugStructuredError {
  code: string;
  origin: string;
  message: string;
  suggested_action: string;
  context: Record<string, unknown>;
}

export interface WorkflowDebugLog {
  schema_version: 1;
  generated_at: number;
  workflow: Record<string, unknown>;
  control_state: Record<string, unknown> | null;
  tasks: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  model_calls: Array<Record<string, unknown>>;
  subagent_runs: Array<Record<string, unknown>>;
  quality_reviews: Array<Record<string, unknown>>;
  runtime_state: {
    executor_capabilities: Array<Record<string, unknown>>;
    active_sessions: Array<Record<string, unknown>>;
    active_turns: Array<Record<string, unknown>>;
    stream_events: Array<Record<string, unknown>>;
    notes: string[];
  };
  context_orchestration: {
    channels: Array<Record<string, unknown>>;
    threads: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    context_packets: Array<Record<string, unknown>>;
    task_handoffs: Array<Record<string, unknown>>;
    work_items: Array<Record<string, unknown>>;
    decisions: Array<Record<string, unknown>>;
  };
  terminal_lines: string[];
  structured_errors: WorkflowDebugStructuredError[];
  historical_errors: WorkflowDebugStructuredError[];
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row?.name === table;
}

function redactString(value: string, workspace: string, db: Database.Database): string {
  let out = value;
  try {
    out = redactSecrets(out, workspace, db);
  } catch {
    // Older test DBs may not have the vault schema. Regex redaction still runs.
  }
  out = redactContextText(out);
  return applySecretPatterns(out);
}

function safeParseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return raw ?? null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function sanitize(value: unknown, workspace: string, db: Database.Database): unknown {
  if (typeof value === 'string') return redactString(value, workspace, db);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, workspace, db));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = sanitize(nested, workspace, db);
    }
    return out;
  }
  return value;
}

function parseAndSanitize(raw: unknown, workspace: string, db: Database.Database): unknown {
  return sanitize(redactContextJson(safeParseJson(raw)), workspace, db);
}

function parseJsonColumns(
  row: Record<string, unknown>,
  workspace: string,
  db: Database.Database,
  columns: string[],
): Record<string, unknown> {
  const out = sanitize(row, workspace, db) as Record<string, unknown>;
  for (const column of columns) {
    if (column in row) {
      const key = column.endsWith('_json') ? column.slice(0, -5) : column;
      out[key] = parseAndSanitize(row[column], workspace, db);
      delete out[column];
    }
  }
  return out;
}

function compactPreview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function formatIso(ts: unknown): string {
  return typeof ts === 'number' && Number.isFinite(ts)
    ? new Date(ts).toISOString()
    : 'unknown-time';
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
    )
    : [];
}

function runtimeEventPreview(row: Record<string, unknown>): string {
  const event = safeRecord(row['event']);
  const raw = safeRecord(event['raw']);
  const text = typeof event['text'] === 'string'
    ? event['text']
    : typeof event['message'] === 'string'
      ? event['message']
      : typeof event['delta'] === 'string'
        ? event['delta']
        : '';
  const base = text.trim()
    ? text.replace(/\s+/g, ' ').trim()
    : compactPreview(event);
  const stream = typeof raw['stream'] === 'string' ? ` stream=${raw['stream']}` : '';
  const executor = typeof event['executorId'] === 'string' ? ` executor=${event['executorId']}` : '';
  return `${executor}${stream} ${base}`.trim();
}

const TASK_ID_PATTERN = /\btk_[A-Za-z0-9_-]+\b/g;

function extractReferencedTaskIds(text: string): string[] {
  return Array.from(new Set(text.match(TASK_ID_PATTERN) ?? []));
}

function formatRuntimeSessionLine(row: Record<string, unknown>): string {
  const metadata = safeRecord(row['metadata']);
  const model = typeof metadata['model'] === 'string' ? ` model=${metadata['model']}` : '';
  const hint = typeof metadata['executor_hint'] === 'string' ? ` executor_hint=${metadata['executor_hint']}` : '';
  const fallback = typeof row['fallback_reason'] === 'string' && row['fallback_reason']
    ? ` fallback=${row['fallback_reason']}`
    : '';
  return `[${formatIso(row['created_at'])}] runtime_session task=${String(row['task_id'] ?? 'workflow')} executor=${String(row['executor_id'] ?? 'unknown')}${model}${hint} protocol=${String(row['protocol_tier'] ?? 'unknown')} stream=${String(row['stream_format'] ?? 'unknown')} run_mode=${String(row['run_mode'] ?? 'unknown')} approval=${String(row['approval_status'] ?? 'unknown')} audit=${String(row['audit_status'] ?? 'unknown')}${fallback}`;
}

function formatRuntimeStreamLine(row: Record<string, unknown>): string {
  return `[${formatIso(row['created_at'])}] runtime_event #${String(row['seq'] ?? row['id'] ?? '?')} task=${String(row['task_id'] ?? 'workflow')} type=${String(row['type'] ?? 'runtime')} ${runtimeEventPreview(row)}`;
}

function structuredErrorFromEvent(event: Record<string, unknown>): WorkflowDebugStructuredError | null {
  const type = String(event['type'] ?? '');
  const payload = event['payload'];
  const lower = type.toLowerCase();
  const isError =
    lower.includes('error') ||
    lower.includes('fail') ||
    lower.includes('hung') ||
    lower.includes('timeout') ||
    lower.includes('cancel') ||
    lower.includes('blocked');
  if (!isError) return null;

  const payloadMessage =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)['error'] ??
        (payload as Record<string, unknown>)['message'] ??
        (payload as Record<string, unknown>)['reason']
      : payload;
  const message = typeof payloadMessage === 'string' && payloadMessage.trim()
    ? payloadMessage
    : compactPreview(payload ?? type);
  const eventTaskId = typeof event['task_id'] === 'string' ? event['task_id'] : null;
  const referencedTaskId = extractReferencedTaskIds(message)[0] ?? null;
  const originTaskId = referencedTaskId ?? eventTaskId;

  return {
    code: type,
    origin: originTaskId ? `task:${originTaskId}` : 'workflow',
    message,
    suggested_action: 'Inspect the task row, terminal lines, and recent model/CLI events before retrying.',
    context: {
      event_id: event['id'],
      task_id: originTaskId,
      ...(eventTaskId && eventTaskId !== originTaskId ? { event_task_id: eventTaskId } : {}),
      timestamp: event['timestamp'],
    },
  };
}

function formatQualityReviewLine(row: Record<string, unknown>): string {
  const issues = safeRecordArray(row['issues']);
  const fixTasks = safeRecordArray(row['fix_tasks']);
  const taskRef = row['task_id'] ? ` task=${String(row['task_id'])}` : '';
  return `[${formatIso(row['created_at'])}] quality_review ${String(row['id'] ?? '?')}${taskRef} scope=${String(row['scope'] ?? 'unknown')} reviewer=${String(row['reviewer_kind'] ?? 'unknown')} outcome=${String(row['outcome'] ?? 'unknown')} score=${String(row['score'] ?? 'n/a')} run_mode=${String(row['run_mode'] ?? 'unknown')} approval=${String(row['approval_status'] ?? 'unknown')} audit=${String(row['audit_status'] ?? 'unknown')} issues=${issues.length} fix_tasks=${fixTasks.length}`;
}

function structuredErrorFromQualityReview(row: Record<string, unknown>): WorkflowDebugStructuredError | null {
  const outcome = String(row['outcome'] ?? '');
  if (outcome !== 'blocked' && outcome !== 'needs_fixes') return null;

  const issues = safeRecordArray(row['issues']);
  const primary = issues.find((issue) =>
    String(issue['severity'] ?? '') === 'blocking' || String(issue['severity'] ?? '') === 'error',
  ) ?? issues[0] ?? {};
  const taskId = typeof row['task_id'] === 'string' ? row['task_id'] : null;
  const scope = String(row['scope'] ?? 'quality');
  const reviewer = String(row['reviewer_kind'] ?? 'quality');

  return {
    code: `quality_${scope}_${outcome}`,
    origin: taskId ? `task:${taskId}` : 'workflow',
    message: typeof primary['message'] === 'string' && primary['message'].trim()
      ? primary['message']
      : `Quality gate ${String(row['id'] ?? '')} returned ${outcome}.`,
    suggested_action: typeof primary['suggestedAction'] === 'string' && primary['suggestedAction'].trim()
      ? primary['suggestedAction']
      : 'Open the Quality tab, inspect the evidence bundle, and run generated fix tasks before marking the workflow complete.',
    context: {
      review_id: row['id'],
      task_id: taskId,
      scope,
      reviewer,
      outcome,
      score: row['score'] ?? null,
      run_mode: row['run_mode'] ?? null,
      approval_status: row['approval_status'] ?? null,
      audit_status: row['audit_status'] ?? null,
      issue_count: issues.length,
    },
  };
}

function structuredErrorFromTask(task: Record<string, unknown>): WorkflowDebugStructuredError | null {
  if (task['status'] !== 'failed' && task['status'] !== 'failover') return null;
  return {
    code: `task_${String(task['status'])}`,
    origin: `task:${String(task['id'])}`,
    message: typeof task['output'] === 'string' && task['output'].trim()
      ? compactPreview(task['output'])
      : `Task "${String(task['name'] ?? task['id'])}" ended with status ${String(task['status'])}.`,
    suggested_action: 'Open this task in the inspector, review input/output, then retry or adjust the task.',
    context: {
      task_id: task['id'],
      kind: task['kind'],
      model: task['model'] ?? null,
      executor_hint: task['executor_hint'] ?? null,
    },
  };
}

function errorIsHistorical(
  error: WorkflowDebugStructuredError,
  taskStatusById: Map<string, string>,
  workflowStatus: string,
  latestTaskStartById: Map<string, number>,
): boolean {
  const referencedTaskIds = extractReferencedTaskIds(error.message)
    .filter((taskId) => taskStatusById.has(taskId));
  const contextTaskId = typeof error.context['task_id'] === 'string'
    ? error.context['task_id'] as string
    : error.origin.startsWith('task:')
      ? error.origin.slice('task:'.length)
      : null;
  const taskIds = Array.from(new Set([
    ...referencedTaskIds,
    ...(contextTaskId && taskStatusById.has(contextTaskId) ? [contextTaskId] : []),
  ]));

  if (taskIds.length > 0) {
    const errorTimestamp = typeof error.context['timestamp'] === 'number'
      ? error.context['timestamp'] as number
      : null;
    if (errorTimestamp !== null && taskIds.some((taskId) => {
      const latestStart = latestTaskStartById.get(taskId);
      return typeof latestStart === 'number' && errorTimestamp < latestStart;
    })) {
      return true;
    }

    return taskIds.every((taskId) => {
      const taskStatus = taskStatusById.get(taskId);
      return taskStatus === 'completed' || taskStatus === 'skipped';
    });
  }

  return workflowStatus === 'completed';
}

export function buildWorkflowDebugLog(
  db: Database.Database,
  workflowId: string,
): WorkflowDebugLog {
  const workflow = db
    .prepare(`SELECT * FROM workflows WHERE id = ?`)
    .get(workflowId) as Record<string, unknown> | undefined;
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  const workspace = String(workflow['workspace'] ?? '');
  const tasks: Array<Record<string, unknown>> = (db
    .prepare(`SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC, id ASC`)
    .all(workflowId) as Array<Record<string, unknown>>).map((row) =>
      parseJsonColumns(row, workspace, db, ['depends_on_json', 'input_json', 'output_json']),
    );

  const events: Array<Record<string, unknown>> = (db
    .prepare(`SELECT * FROM events WHERE workflow_id = ? ORDER BY id ASC LIMIT 2000`)
    .all(workflowId) as Array<Record<string, unknown>>).map((row) =>
      parseJsonColumns(row, workspace, db, ['payload_json']),
    );

  const modelCalls = tableExists(db, 'model_calls')
    ? db.prepare(`SELECT * FROM model_calls WHERE workflow_id = ? ORDER BY created_at ASC`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];

  const subagentRuns = tableExists(db, 'subagent_runs')
    ? db.prepare(`SELECT * FROM subagent_runs WHERE workflow_id = ? ORDER BY created_at ASC`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const qualityReviewRows = tableExists(db, 'quality_reviews')
    ? (db.prepare(`SELECT * FROM quality_reviews WHERE workflow_id = ? ORDER BY created_at ASC, id ASC`)
      .all(workflowId) as Array<Record<string, unknown>>).map((row) =>
        parseJsonColumns(row, workspace, db, ['issues_json', 'evidence_json', 'fix_tasks_json']),
      )
    : [];

  const controlState = tableExists(db, 'workflow_control_state')
    ? db.prepare(`SELECT * FROM workflow_control_state WHERE workflow_id = ?`).get(workflowId) as Record<string, unknown> | undefined
    : undefined;

  const contextChannels = tableExists(db, 'context_channels')
    ? db.prepare(`SELECT * FROM context_channels WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT 100`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const contextThreads = tableExists(db, 'context_threads')
    ? db.prepare(`SELECT * FROM context_threads WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const contextMessages = tableExists(db, 'context_messages') && tableExists(db, 'context_threads')
    ? db.prepare(
      `SELECT m.*
         FROM context_messages m
         JOIN context_threads t ON t.id = m.thread_id
        WHERE t.run_id = ?
        ORDER BY m.created_at ASC, m.seq ASC
        LIMIT 1000`,
    ).all(workflowId) as Array<Record<string, unknown>>
    : [];
  const contextPackets = tableExists(db, 'context_packets')
    ? db.prepare(`SELECT * FROM context_packets WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const taskHandoffs = tableExists(db, 'task_handoffs')
    ? db.prepare(`SELECT * FROM task_handoffs WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const workItems = tableExists(db, 'work_items')
    ? db.prepare(`SELECT * FROM work_items WHERE run_id = ? ORDER BY order_index ASC, created_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const contextDecisions = tableExists(db, 'context_decisions')
    ? db.prepare(`SELECT * FROM context_decisions WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const runtimeSessions = tableExists(db, 'runtime_sessions')
    ? db.prepare(`SELECT * FROM runtime_sessions WHERE workflow_id = ? ORDER BY updated_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const runtimeTurns = tableExists(db, 'runtime_turns')
    ? db.prepare(`SELECT * FROM runtime_turns WHERE workflow_id = ? ORDER BY started_at ASC, id ASC LIMIT 500`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const runtimeStreamEvents = tableExists(db, 'runtime_stream_events')
    ? db.prepare(`SELECT * FROM runtime_stream_events WHERE workflow_id = ? ORDER BY created_at ASC, id ASC LIMIT 1000`)
      .all(workflowId) as Array<Record<string, unknown>>
    : [];
  const runtimeSessionRows = runtimeSessions.map((row) =>
    parseJsonColumns(row, workspace, db, ['metadata_json']),
  );
  const runtimeTurnRows = runtimeTurns.map((row) =>
    parseJsonColumns(row, workspace, db, ['metadata_json', 'error_json']),
  );
  const runtimeStreamRows = runtimeStreamEvents.map((row) =>
    parseJsonColumns(row, workspace, db, ['event_json']),
  );

  const taskStatusById = new Map(
    tasks.map((task) => [String(task['id']), String(task['status'] ?? '')]),
  );
  const latestTaskStartById = new Map<string, number>();
  for (const event of events) {
    if (event['type'] !== 'task_started' || typeof event['task_id'] !== 'string') continue;
    const timestamp = typeof event['timestamp'] === 'number' ? event['timestamp'] : null;
    if (timestamp === null) continue;
    const prior = latestTaskStartById.get(event['task_id']);
    if (prior === undefined || timestamp > prior) latestTaskStartById.set(event['task_id'], timestamp);
  }
  const allStructuredErrors = [
    ...events.map(structuredErrorFromEvent).filter((v): v is WorkflowDebugStructuredError => v !== null),
    ...tasks.map(structuredErrorFromTask).filter((v): v is WorkflowDebugStructuredError => v !== null),
    ...qualityReviewRows.map(structuredErrorFromQualityReview).filter((v): v is WorkflowDebugStructuredError => v !== null),
  ];
  const workflowStatus = String(workflow['status'] ?? '');
  const workflowRow = parseJsonColumns(workflow, workspace, db, ['metadata']);
  const workflowMetadata = safeRecord(workflowRow['metadata']);
  const workflowMode = typeof workflowMetadata['workflow_mode'] === 'string'
    ? workflowMetadata['workflow_mode']
    : 'standard';
  workflowRow['workflow_mode'] = workflowMode;
  const historicalErrors = allStructuredErrors.filter((err) =>
    errorIsHistorical(err, taskStatusById, workflowStatus, latestTaskStartById),
  );
  const structuredErrors = allStructuredErrors.filter((err) =>
    !errorIsHistorical(err, taskStatusById, workflowStatus, latestTaskStartById),
  );

  const terminalLines = [
    `[${formatIso(workflow['created_at'])}] workflow ${workflowId} status=${workflowStatus} workspace=${workspace} mode=${workflowMode}`,
    ...tasks.map((task, index) =>
      `[${formatIso(task['created_at'])}] task ${String(index + 1).padStart(2, '0')} ${String(task['id'])} status=${String(task['status'])} kind=${String(task['kind'])} model=${String(task['model'] ?? 'unset')} name="${String(task['name'] ?? '')}"`,
    ),
    ...events.map((event) => {
      const taskRef = event['task_id'] ? ` task=${String(event['task_id'])}` : '';
      return `[${formatIso(event['timestamp'])}] event ${String(event['id'])} ${String(event['type'])}${taskRef} ${compactPreview(event['payload'] ?? '')}`;
    }),
    ...qualityReviewRows.map(formatQualityReviewLine),
    ...runtimeSessionRows.map(formatRuntimeSessionLine),
    ...runtimeStreamRows.map(formatRuntimeStreamLine),
    historicalErrors.length > 0
      ? `[${formatIso(Date.now())}] debugger_note historical_errors=${historicalErrors.length} resolved by current workflow/task state; see historical_errors/events for prior failed attempts.`
      : null,
  ].filter((line): line is string => typeof line === 'string');

  return {
    schema_version: 1,
    generated_at: Date.now(),
    workflow: workflowRow,
    control_state: controlState ? sanitize(controlState, workspace, db) as Record<string, unknown> : null,
    tasks,
    events,
    model_calls: modelCalls.map((row) => sanitize(row, workspace, db) as Record<string, unknown>),
    subagent_runs: subagentRuns.map((row) => sanitize(row, workspace, db) as Record<string, unknown>),
    quality_reviews: qualityReviewRows,
    runtime_state: {
      executor_capabilities: listRuntimeExecutorCapabilities().map((capability) =>
        sanitize(capability, workspace, db) as Record<string, unknown>,
      ),
      active_sessions: runtimeSessionRows,
      active_turns: runtimeTurnRows,
      stream_events: runtimeStreamRows,
      notes: runtimeSessions.length > 0
        ? ['Runtime sessions/turns are persisted for this workflow. ACP/server transports remain planned/experimental until probe artifacts mark them verified.']
        : [
          'Runtime sessions/turns are not persisted for this workflow yet; capability metadata is available for routing/debug.',
          'ACP/server transports remain planned/experimental until probe artifacts mark them verified.',
        ],
    },
    context_orchestration: {
      channels: contextChannels.map((row) => parseJsonColumns(row, workspace, db, ['metadata_json'])),
      threads: contextThreads.map((row) => parseJsonColumns(row, workspace, db, ['metadata_json'])),
      messages: contextMessages.map((row) => parseJsonColumns(row, workspace, db, ['metadata_json'])),
      context_packets: contextPackets.map((row) => parseJsonColumns(row, workspace, db, [
        'packet_json',
        'included_handoffs_json',
        'excluded_items_json',
      ])),
      task_handoffs: taskHandoffs.map((row) => parseJsonColumns(row, workspace, db, [
        'artifacts_json',
        'files_touched_json',
        'decisions_json',
        'safe_context_json',
      ])),
      work_items: workItems.map((row) => parseJsonColumns(row, workspace, db, ['metadata_json'])),
      decisions: contextDecisions.map((row) => parseJsonColumns(row, workspace, db, ['metadata_json'])),
    },
    terminal_lines: terminalLines,
    structured_errors: structuredErrors,
    historical_errors: historicalErrors,
  };
}
