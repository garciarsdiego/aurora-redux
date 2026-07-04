import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { QualityEvidenceRef, TaskQualityEvidenceBundle } from './types.js';
import type { Task, Workflow } from '../types/index.js';
import { verifyAcceptanceArtifacts } from '../v2/agents/validators/filesystem.js';
import { redactContextJson, redactContextText } from '../context/redaction.js';

interface TaskRow extends Omit<Task, 'depends_on' | 'kind' | 'status' | 'hitl'> {
  depends_on_json: string | null;
  kind: string;
  status: string;
  hitl: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    ...row,
    kind: row.kind as Task['kind'],
    status: row.status as Task['status'],
    depends_on: row.depends_on_json ? (JSON.parse(row.depends_on_json) as string[]) : [],
    hitl: Boolean(row.hitl),
  };
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row?.name === table;
}

function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasReviewableEntries(dir: string | null): boolean {
  if (!dir) return false;
  try {
    if (!existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.name !== '.git');
  } catch {
    return false;
  }
}

function outputMentionsOutputDir(output: string, outputDir: string | null): boolean {
  if (!outputDir) return false;
  const normalizedOutput = output.replace(/\\/g, '/').toLowerCase();
  const normalizedDir = outputDir.replace(/\\/g, '/').toLowerCase();
  return normalizedOutput.includes(normalizedDir) || /\bOUTPUT_DIR\b/i.test(output);
}

export function resolveQualityWorkspaceDir(task: Task, workspace: string, output: string): {
  workspaceDir: string;
  worktreeRoot: string | null;
  outputDir: string | null;
  sourceCwd: string | null;
} {
  const input = safeParseJson(task.input_json);
  const exec =
    input['execution_context'] && typeof input['execution_context'] === 'object'
      ? (input['execution_context'] as Record<string, unknown>)
      : {};
  const outputDir = optionalPath(exec['output_dir']);
  const worktreeRoot = optionalPath(exec['worktree_root']);
  const sourceCwd = optionalPath(exec['source_cwd']) ?? optionalPath(exec['cwd']);
  const workspaceDir =
    outputDir &&
    (outputMentionsOutputDir(output, outputDir) ||
      (hasReviewableEntries(outputDir) && !hasReviewableEntries(worktreeRoot)))
      ? outputDir
      : worktreeRoot ?? sourceCwd ?? resolve('workspaces', workspace);
  return {
    workspaceDir,
    worktreeRoot,
    outputDir,
    sourceCwd,
  };
}

function compactPreview(raw: unknown, maxChars = 2500): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const redacted = redactContextText(text ?? '');
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[...truncated...]` : redacted;
}

function parseJsonColumns(
  row: Record<string, unknown>,
  jsonColumns: string[],
): Record<string, unknown> {
  const out = redactContextJson({ ...row }) as Record<string, unknown>;
  for (const column of jsonColumns) {
    if (column in row) {
      const target = column.endsWith('_json') ? column.slice(0, -5) : column;
      const raw = row[column];
      if (typeof raw === 'string' && raw.trim()) {
        try {
          out[target] = redactContextJson(JSON.parse(raw) as unknown);
        } catch {
          out[target] = redactContextText(raw);
        }
      } else {
        out[target] = raw ?? null;
      }
      delete out[column];
    }
  }
  return out;
}

function limitRows(
  db: Database.Database,
  sql: string,
  params: unknown[],
  jsonColumns: string[] = [],
): Array<Record<string, unknown>> {
  return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>)
    .map((row) => parseJsonColumns(row, jsonColumns));
}

function loadArtifactRefs(db: Database.Database, workflowId: string, taskId: string): QualityEvidenceRef[] {
  if (!tableExists(db, 'artifacts')) return [];
  const rows = db
    .prepare(
      `SELECT kind, content_path, size_bytes, hash_sha256, created_at
         FROM artifacts
        WHERE workflow_id = ? AND task_id = ?
        ORDER BY created_at ASC
        LIMIT 50`,
    )
    .all(workflowId, taskId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    kind: 'artifact',
    label: String(row['kind'] ?? 'artifact'),
    path: typeof row['content_path'] === 'string' ? row['content_path'] : undefined,
    metadata: redactContextJson({
      size_bytes: row['size_bytes'] ?? null,
      hash_sha256: row['hash_sha256'] ?? null,
      created_at: row['created_at'] ?? null,
    }),
  }));
}

export function buildTaskQualityEvidenceBundle(
  db: Database.Database,
  workflowId: string,
  taskId: string,
): TaskQualityEvidenceBundle {
  const workflow = db
    .prepare(`SELECT * FROM workflows WHERE id = ?`)
    .get(workflowId) as Workflow | undefined;
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  const taskRow = db
    .prepare(`SELECT * FROM tasks WHERE id = ? AND workflow_id = ?`)
    .get(taskId, workflowId) as TaskRow | undefined;
  if (!taskRow) throw new Error(`Task not found: ${taskId}`);

  const task = rowToTask(taskRow);
  const output = task.output_json ?? '';
  const executionContext = resolveQualityWorkspaceDir(task, workflow.workspace, output);
  const filesystem = verifyAcceptanceArtifacts(task.acceptance_criteria, executionContext.workspaceDir);

  const eventsTail = limitRows(
    db,
    `SELECT id, task_id, type, payload_json, timestamp
       FROM events
      WHERE workflow_id = ? AND (task_id = ? OR task_id IS NULL)
      ORDER BY id DESC
      LIMIT 60`,
    [workflowId, taskId],
    ['payload_json'],
  ).reverse();

  const runtimeEventsTail = tableExists(db, 'runtime_stream_events')
    ? limitRows(
      db,
      `SELECT id, task_id, turn_id, seq, type, event_json, created_at
         FROM runtime_stream_events
        WHERE workflow_id = ? AND task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 80`,
      [workflowId, taskId],
      ['event_json'],
    ).reverse()
    : [];

  const contextPacketsTail = tableExists(db, 'context_packets')
    ? limitRows(
      db,
      `SELECT id, run_id, task_id, attempt, packet_json, included_handoffs_json,
              excluded_items_json, token_estimate, truncated, created_at
         FROM context_packets
        WHERE run_id = ? AND task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
      [workflowId, taskId],
      ['packet_json', 'included_handoffs_json', 'excluded_items_json'],
    ).reverse()
    : [];

  const handoffsTail = tableExists(db, 'task_handoffs')
    ? limitRows(
      db,
      `SELECT id, run_id, task_id, attempt, kind, title, body, artifacts_json,
              files_touched_json, decisions_json, safe_context_json, token_estimate,
              truncated, created_at
         FROM task_handoffs
        WHERE run_id = ? AND task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
      [workflowId, taskId],
      ['artifacts_json', 'files_touched_json', 'decisions_json', 'safe_context_json'],
    ).reverse()
    : [];

  return {
    workflow: {
      id: workflow.id,
      workspace: workflow.workspace,
      objective: redactContextText(workflow.objective),
      status: workflow.status,
    },
    task: {
      id: task.id,
      name: redactContextText(task.name),
      kind: task.kind,
      status: task.status,
      model: task.model ?? null,
      executorHint: task.executor_hint ?? null,
      acceptanceCriteria: task.acceptance_criteria ? redactContextText(task.acceptance_criteria) : null,
      retryCount: task.retry_count,
      refineCount: task.refine_count,
    },
    executionContext,
    output: {
      chars: output.length,
      preview: compactPreview(output),
    },
    filesystem,
    artifacts: loadArtifactRefs(db, workflowId, taskId),
    eventsTail,
    runtimeEventsTail,
    contextPacketsTail,
    handoffsTail,
  };
}
