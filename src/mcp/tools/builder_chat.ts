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
import { callOmnirouteWithUsage } from '../../utils/omniroute-call.js';
import { runAgent, createInMemoryContext, type AgentInvoker } from '../../v2/agents/runner.js';
import { BUILDER_CONVERSATIONAL_PERSONA } from '../../v2/agents/personas/builder_conversational.js';
import { createVersionedDefinition } from '../../v2/governance/versioned-registry.js';
import {
  upsertDashboardPlannerSession,
  listDashboardPlannerSessions,
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
// Omniroute invoker (same pattern as decomposer.ts)
// ─────────────────────────────────────────────────────────────────────────────

const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    model: args.model,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
  });
  return result.content;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool handler
// ─────────────────────────────────────────────────────────────────────────────

export async function omniforge_builder_chat(raw: unknown): Promise<string> {
  const input = BuilderChatSchema.parse(raw);
  const db = initDb(getDbPath());

  try {
    // 1. Load existing session (or start fresh)
    const sessions = listDashboardPlannerSessions(db, {
      workspace: input.workspace,
      limit: 100,
    });
    const existing = sessions.find((s) => s.id === input.session_id);

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
      const defId = `builder_${input.session_id}_${Date.now()}`;
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
      // Patch the assistant message with the materialised id
      assistantMsg.text = output.reply;
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
