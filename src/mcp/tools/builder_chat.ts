/**
 * omniforge_builder_chat — conversational AI Builder MCP tool.
 *
 * Accepts { workspace, session_id, message }, appends the user message to the
 * persisted planner-session conversation, calls the BUILDER_CONVERSATIONAL_PERSONA
 * via runAgent, persists the assistant reply back into the session, and — when
 * action=create_orchestration — materializes the DAG via registerVersionedDefinition.
 */

import { z } from 'zod';

import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { DagSchema } from '../../types/schemas.js';
import { runAgent, createInMemoryContext } from '../../v2/agents/runner.js';
import { BUILDER_CONVERSATIONAL_PERSONA } from '../../v2/agents/personas/builder_conversational.js';
import { createVersionedDefinition } from '../../v2/governance/versioned-registry.js';
import { omnirouteInvoker } from './omniroute-invoker.js';
import {
  upsertDashboardPlannerSession,
  PlannerMessageSchema,
  type DashboardPlannerMessage,
} from '../dashboard-planner-sessions.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const BuilderChatSchema = z.object({
  workspace: z.string().min(1),
  session_id: z.string().min(1),
  message: z.string().min(1),
});
export type BuilderChatInput = z.infer<typeof BuilderChatSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Tool handler
// ─────────────────────────────────────────────────────────────────────────────

export async function omniforge_builder_chat(raw: unknown): Promise<string> {
  const input = BuilderChatSchema.parse(raw);
  const db = initDb(getDbPath());

  try {
    // 1. Load existing session (or start fresh). Direct lookup by id — the
    // previous list(limit)+find approach silently dropped the conversation
    // history once the workspace accumulated more sessions than one page.
    const row = db.prepare(
      `SELECT title, objective, messages_json, dag_json
         FROM dashboard_planner_sessions
        WHERE id = ? AND workspace = ?`,
    ).get(input.session_id, input.workspace) as
      | { title: string; objective: string; messages_json: string; dag_json: string | null }
      | undefined;
    const existing = row
      ? {
        title: row.title,
        objective: row.objective,
        messages: z.array(PlannerMessageSchema).parse(JSON.parse(row.messages_json) as unknown),
        dag: row.dag_json ? DagSchema.parse(JSON.parse(row.dag_json) as unknown) : null,
      }
      : undefined;

    const priorMessages: DashboardPlannerMessage[] = existing?.messages ?? [];

    // 2. Append new user message
    const userMsgId = `msg_${Date.now()}_u`;
    const userMsg: DashboardPlannerMessage = {
      id: userMsgId,
      role: 'user',
      text: input.message,
    };
    const conversation = [...priorMessages, userMsg];

    // 3. Build persona input (use sensible defaults for available_models/clis)
    const personaInput = {
      workspace: input.workspace,
      session_id: input.session_id,
      conversation: conversation.map((m) => ({
        role: m.role,
        text: m.text,
        dag: undefined,
        action: undefined as string | undefined,
      })),
      current_dag: existing?.dag ?? undefined,
      available_models: [
        { model_id: 'cc/claude-sonnet-4-6', family: 'claude' },
        { model_id: 'cc/claude-opus-4-6', family: 'claude' },
        { model_id: 'cx/gpt-5.5', family: 'openai' },
        { model_id: 'go/gemini-3.1-pro-preview', family: 'gemini' },
      ],
      available_clis: ['claude-code', 'codex', 'gemini', 'kimi', 'cursor', 'opencode'],
    };

    const ctx = createInMemoryContext({
      workflowId: `builder_${input.session_id}`,
      taskId: userMsgId,
    });

    // 4. Run the builder persona
    const output = await runAgent(
      BUILDER_CONVERSATIONAL_PERSONA,
      personaInput,
      ctx,
      { invoke: omnirouteInvoker, parseJson: true },
    );

    // 5. Append assistant reply to conversation
    const assistantMsgId = `msg_${Date.now()}_a`;
    const parsedDag = output.dag != null ? DagSchema.safeParse(output.dag) : null;
    const assistantMsg: DashboardPlannerMessage = {
      id: assistantMsgId,
      role: 'assistant',
      text: output.reply,
      dag: parsedDag?.success ? parsedDag.data : undefined,
      taskCount: parsedDag?.success ? parsedDag.data.tasks?.length : undefined,
    };
    const updatedMessages = [...conversation, assistantMsg];

    // 6. Handle create_orchestration — materialize via registerVersionedDefinition
    let materializedId: string | undefined;
    if (output.action === 'create_orchestration' && output.dag != null) {
      const def = createVersionedDefinition(db, {
        workspace: input.workspace,
        kind: 'agent',
        name: `builder_dag_${input.session_id}`,
        version: '1.0.0',
        status: 'draft',
        spec: output.dag,
        createdBy: 'omniforge_builder_chat',
        notes: `Materialized from builder chat session ${input.session_id}`,
      });
      materializedId = def.id;
    }

    // 7. Persist session
    const sessionTitle = existing?.title ?? `Builder session ${input.session_id.slice(0, 8)}`;
    const sessionObjective = existing?.objective ?? input.message;

    upsertDashboardPlannerSession(db, {
      id: input.session_id,
      title: sessionTitle,
      workspace: input.workspace,
      objective: sessionObjective,
      messages: updatedMessages,
      dag: (parsedDag?.success ? parsedDag.data : null) ?? existing?.dag ?? null,
    });

    return JSON.stringify({
      session_id: input.session_id,
      reply: output.reply,
      action: output.action,
      dag: output.dag,
      ascii_flow_diagram: output.ascii_flow_diagram,
      clarification_questions: output.clarification_questions,
      materialized_orchestration_id: materializedId ?? output.materialized_orchestration_id,
    });
  } finally {
    db.close();
  }
}
