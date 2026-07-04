import { z } from 'zod';

import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import { callOmnirouteWithUsage } from '../../utils/omniroute-call.js';
import {
  BUILDER_CONVERSATIONAL_PERSONA,
  CONSOLIDATOR_PERSONA,
  DECOMPOSER_PERSONA,
  FAILOVER_CLASSIFIER_PERSONA,
  REFINER_PERSONA,
  REVIEWER_PERSONA,
  WORKER_ADVISOR_CALL_PERSONA,
  WORKER_CLI_SPAWN_PERSONA,
  WORKER_LLM_CALL_PERSONA,
  WORKER_TOOL_CALL_PERSONA,
  createInMemoryContext,
  runAgent,
  type AgentInvoker,
  type AgentPersona,
} from '../../v2/agents/index.js';
import {
  buildAmendedPersona,
  diffPersonaOutputs,
  getPersonaVersionSnapshot,
} from '../../v2/agents/version-registry.js';

export const toolName = 'omniforge_replay_persona_version';

export const inputSchema = z.object({
  persona_id: z.string().min(1),
  version: z.string().min(1),
  input: z.unknown(),
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name').default('global'),
});

const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    model: args.model,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
  });
  return result.content;
};

const LIVE_PERSONAS = [
  BUILDER_CONVERSATIONAL_PERSONA,
  CONSOLIDATOR_PERSONA,
  DECOMPOSER_PERSONA,
  FAILOVER_CLASSIFIER_PERSONA,
  REFINER_PERSONA,
  REVIEWER_PERSONA,
  WORKER_ADVISOR_CALL_PERSONA,
  WORKER_CLI_SPAWN_PERSONA,
  WORKER_LLM_CALL_PERSONA,
  WORKER_TOOL_CALL_PERSONA,
] as readonly AgentPersona<any, any>[];

function findLivePersona(personaId: string): AgentPersona<any, any> {
  const persona = LIVE_PERSONAS.find((p) => p.id === personaId);
  if (!persona) {
    throw new Error(`Unknown live persona '${personaId}'`);
  }
  return persona;
}

export async function handler(raw: unknown): Promise<string> {
  const input = inputSchema.parse(raw);
  const db = initDb(getDbPath());

  try {
    const livePersona = findLivePersona(input.persona_id);
    const snapshot = getPersonaVersionSnapshot(db, input.persona_id, input.version, {
      workspace: input.workspace,
    });
    if (!snapshot) {
      throw new Error(
        `Snapshot not found for persona '${input.persona_id}' version '${input.version}' in workspace '${input.workspace}'`,
      );
    }

    const replayPersona = buildAmendedPersona(livePersona, snapshot);
    const replayCtx = createInMemoryContext({
      workflowId: `persona_replay_${input.persona_id}_${input.version}`,
      taskId: 'replay',
    });
    const liveCtx = createInMemoryContext({
      workflowId: `persona_replay_${input.persona_id}_live`,
      taskId: 'live',
    });

    const replayedOutput = await runAgent(replayPersona, input.input, replayCtx, {
      invoke: omnirouteInvoker,
      parseJson: true,
    });
    const liveOutput = await runAgent(livePersona, input.input, liveCtx, {
      invoke: omnirouteInvoker,
      parseJson: true,
    });

    return JSON.stringify({
      persona_id: input.persona_id,
      version: input.version,
      workspace: input.workspace,
      replayed_output: replayedOutput,
      live_output: liveOutput,
      diff: diffPersonaOutputs(liveOutput, replayedOutput),
      replay_events: replayCtx.events,
      live_events: liveCtx.events,
    });
  } finally {
    db.close();
  }
}

export const replayPersonaVersionTool = handler;
