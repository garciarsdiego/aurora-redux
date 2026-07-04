// Wave 2 Agent M1-W2-C (B7, 2026-05-12): cost preview endpoint.
//
// Closes the dead UX bullet where AskScreen.tsx + CommandCenter.tsx
// hardcoded "~$0.XX" with a comment "preview cost API not yet wired".
//
// Heuristic (acceptable for MVP per the brief — ±50% accuracy is fine):
//   1. Tokenize the operator-typed objective via `estimateTokens` from
//      `v2/context-engine/estimate-tokens.ts` (the same primitive the
//      executor uses for context budgeting).
//   2. Multiply by 3 to approximate `input + decompose + tasks` total
//      input traffic. This is a deliberately loose lower bound — most
//      workflows materialize more tokens via task fan-out, but until we
//      have a real plan we cannot price per-task.
//   3. Pick a model via `getTaskModel()` (operator-overridable env var,
//      default `claude/claude-sonnet-4-6`). The brief mentioned
//      `routeModel` but the catalog only has tier/score data, not USD
//      pricing — `routeModel` would not improve the estimate. Instead
//      we use the configured TASK_MODEL because every cli_spawn/llm_call
//      task hits it.
//   4. Compute USD via `estimateCost(model, inputTokens, outputTokens)`
//      from `v2/llm-ledger/pricing.ts`, using 0 for output (the real
//      output isn't known pre-run).
//
// Response shape: `{ estimated_tokens, estimated_usd, model }`.
//
// The estimate is debounced on the client (500 ms) so we don't hammer
// the daemon while the operator types. We do NOT cache the result per
// objective; the call is cheap (no DB, no network).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { estimateTokens } from '../../v2/context-engine/estimate-tokens.js';
import { estimateCost } from '../../v2/llm-ledger/pricing.js';
import { getTaskModel } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody } from './_shared.js';

// Inputs are capped to keep the heuristic responsive. The plan endpoint
// itself accepts up to 200K characters, but at that size the cost preview
// would be misleading anyway (the decomposer trims to 20K). We cap at 20K
// here so the preview number reflects what the LLM will actually see.
const CostPreviewSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)').optional(),
  objective: z.string().min(1).max(20_000, 'objective too long for preview (cap 20K chars)'),
  // Optional override — defaults to TASK_MODEL env var. Surface this as a
  // strict shape so a misconfigured client cannot inject pricing for an
  // unknown provider via a misspelled model id (we still fall back to
  // DEFAULT_PRICING but the audit trail will show the bad id).
  model: z.string().min(1).max(160).optional(),
});

interface CostPreviewResponse {
  estimated_tokens: number;
  estimated_usd: number;
  model: string;
  /** Multiplier applied to raw input-token count. Surfaced so the UI can
   *  show "input × 3 for decompose + tasks" if a tooltip is desired. */
  fanout_multiplier: number;
}

const FANOUT_MULTIPLIER = 3;

function computeCostPreview(objective: string, modelOverride: string | undefined): CostPreviewResponse {
  const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : getTaskModel();
  // estimateTokens takes AgentMessage[] — wrap the objective as a single
  // user message so we get the same ratio the executor uses.
  const baseTokens = estimateTokens([{ role: 'user', content: objective }], model);
  const totalInputTokens = baseTokens * FANOUT_MULTIPLIER;
  const usd = estimateCost(model, totalInputTokens, 0);
  return {
    estimated_tokens: totalInputTokens,
    estimated_usd: Number(usd.toFixed(4)),
    model,
    fanout_multiplier: FANOUT_MULTIPLIER,
  };
}

async function handleCostPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }
  const parsed = CostPreviewSchema.safeParse(body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }
  try {
    const result = computeCostPreview(parsed.data.objective, parsed.data.model);
    jsonOk(res, result);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

export const dashboardCostPreviewRouter: Router = async (req, url, res) => {
  if (req.method === 'POST' && url.pathname === '/api/dashboard/preview-cost') {
    await handleCostPreview(req, res);
    return true;
  }
  return false;
};
