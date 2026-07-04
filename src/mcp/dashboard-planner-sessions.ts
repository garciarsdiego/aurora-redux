import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DagSchema } from '../types/schemas.js';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';

// D-H2.078: planner-message text raised 40K → 200K to match the plan/retry
// schemas and let an operator's pasted spec live in the conversation history.
// Below 200K we keep the bound to defend against accidental megabyte payloads
// (the planner UI is not built for that and SQLite scans get slow).
export const PlannerMessageSchema = z.object({
  id: z.string().trim().min(1).max(160),
  role: z.enum(['user', 'assistant']),
  text: z.string()
    .trim()
    .min(1)
    .max(200_000, {
      message:
        'Planner message exceeds 200,000 characters. Long specs should be attached as files or split into multiple messages.',
    }),
  dag: DagSchema.optional(),
  taskCount: z.number().int().min(0).max(500).optional(),
});

// D-H2.078: objective on session-persistence bumped 4K → 200K. Was the most
// painful cap in the system — large plans pasted into the planner could be
// processed but the session save would silently fail on first send.
export const PlannerSessionInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(120),
  workspace: z.string().trim().min(1).max(64).regex(VALID_WORKSPACE_RE),
  objective: z.string()
    .trim()
    .min(1)
    .max(200_000, {
      message:
        'Objective exceeds 200,000 characters. Save the plan as a .md file and attach it instead, or split the objective into sub-objectives.',
    }),
  messages: z.array(PlannerMessageSchema).max(200),
  dag: DagSchema.nullable(),
  createdAt: z.number().int().positive().optional(),
  updatedAt: z.number().int().positive().optional(),
});

const ListPlannerSessionsSchema = z.object({
  workspace: z.string().trim().min(1).max(64).regex(VALID_WORKSPACE_RE).optional(),
  limit: z.number().int().min(1).max(100).optional().default(40),
});

const RenamePlannerSessionSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export type DashboardPlannerMessage = z.infer<typeof PlannerMessageSchema>;

export interface DashboardPlannerSession {
  id: string;
  title: string;
  workspace: string;
  objective: string;
  messages: DashboardPlannerMessage[];
  dag: z.infer<typeof DagSchema> | null;
  createdAt: number;
  updatedAt: number;
}

interface PlannerSessionRow {
  id: string;
  title: string;
  workspace: string;
  objective: string;
  messages_json: string;
  dag_json: string | null;
  created_at: number;
  updated_at: number;
}

function rowToPlannerSession(row: PlannerSessionRow): DashboardPlannerSession {
  const messages = z.array(PlannerMessageSchema).parse(JSON.parse(row.messages_json) as unknown);
  const dag = row.dag_json
    ? DagSchema.parse(JSON.parse(row.dag_json) as unknown)
    : null;
  return {
    id: row.id,
    title: row.title,
    workspace: row.workspace,
    objective: row.objective,
    messages,
    dag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listDashboardPlannerSessions(
  db: Database.Database,
  raw: unknown,
): DashboardPlannerSession[] {
  const input = ListPlannerSessionsSchema.parse(raw ?? {});
  const rows = input.workspace
    ? db.prepare(
      `SELECT id, title, workspace, objective, messages_json, dag_json, created_at, updated_at
         FROM dashboard_planner_sessions
        WHERE workspace = ?
        ORDER BY updated_at DESC
        LIMIT ?`,
    ).all(input.workspace, input.limit) as PlannerSessionRow[]
    : db.prepare(
      `SELECT id, title, workspace, objective, messages_json, dag_json, created_at, updated_at
         FROM dashboard_planner_sessions
        ORDER BY updated_at DESC
        LIMIT ?`,
    ).all(input.limit) as PlannerSessionRow[];
  return rows.map(rowToPlannerSession);
}

export function upsertDashboardPlannerSession(
  db: Database.Database,
  raw: unknown,
): { session: DashboardPlannerSession } {
  const input = PlannerSessionInputSchema.parse(raw);
  const existing = db.prepare(
    `SELECT created_at
       FROM dashboard_planner_sessions
      WHERE id = ?`,
  ).get(input.id) as { created_at: number } | undefined;
  const createdAt = existing?.created_at ?? input.createdAt ?? Date.now();
  const updatedAt = Date.now();

  db.prepare(
    `INSERT INTO dashboard_planner_sessions
       (id, workspace, title, objective, messages_json, dag_json, created_at, updated_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
     ON CONFLICT(id) DO UPDATE SET
       workspace = excluded.workspace,
       title = excluded.title,
       objective = excluded.objective,
       messages_json = excluded.messages_json,
       dag_json = excluded.dag_json,
       updated_at = excluded.updated_at`,
  ).run(
    input.id,
    input.workspace,
    input.title,
    input.objective,
    JSON.stringify(input.messages),
    input.dag ? JSON.stringify(input.dag) : null,
    createdAt,
    updatedAt,
  );

  return {
    session: {
      id: input.id,
      title: input.title,
      workspace: input.workspace,
      objective: input.objective,
      messages: input.messages,
      dag: input.dag,
      createdAt,
      updatedAt,
    },
  };
}

export function renameDashboardPlannerSession(
  db: Database.Database,
  sessionId: string,
  raw: unknown,
): { session: DashboardPlannerSession } {
  const input = RenamePlannerSessionSchema.parse(raw);
  const updatedAt = Date.now();
  const result = db.prepare(
    `UPDATE dashboard_planner_sessions
        SET title = ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.title, updatedAt, sessionId);
  if (result.changes === 0) throw new Error(`Planner session not found: ${sessionId}`);
  const row = db.prepare(
    `SELECT id, title, workspace, objective, messages_json, dag_json, created_at, updated_at
       FROM dashboard_planner_sessions
      WHERE id = ?`,
  ).get(sessionId) as PlannerSessionRow | undefined;
  if (!row) throw new Error(`Planner session not found after rename: ${sessionId}`);
  return { session: rowToPlannerSession(row) };
}

export function deleteDashboardPlannerSession(
  db: Database.Database,
  sessionId: string,
): { deleted: true; id: string } {
  const result = db.prepare(
    `DELETE FROM dashboard_planner_sessions
      WHERE id = ?`,
  ).run(sessionId);
  if (result.changes === 0) throw new Error(`Planner session not found: ${sessionId}`);
  return { deleted: true, id: sessionId };
}
