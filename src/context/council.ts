import type Database from 'better-sqlite3';
import {
  createContextMessage,
  createContextThread,
  ensureRunContextChannel,
  recordContextDecision,
  type ContextDecisionRow,
  type ContextMessageRow,
  type ContextThreadRow,
} from './store.js';
import { redactContextBody, redactContextJson } from './redaction.js';
import { getAdvisor } from '../v2/advisors/index.js';
import type { AdvisorContext, AdvisorResult, StepwiseAdvisorResult } from '../v2/advisors/types.js';

export interface CouncilParticipant {
  id: string;
  role: string;
}

export interface CreateCouncilRunInput {
  workspace: string;
  runId: string;
  taskId?: string | null;
  topic: string;
  source?: 'workflow' | 'task' | 'debug_bundle' | 'quality_review' | 'handoff';
  participants: CouncilParticipant[];
  contextSummary?: string;
  runMode?: 'dry-run' | 'approved-run';
  approvedBy?: string | null;
  actor?: string;
  /**
   * F6-4: When true (and runMode === 'dry-run'), invoke real advisor LLMs for
   * each participant via `getAdvisor(name)` instead of writing the
   * deterministic position template. Each advisor reply is persisted as a
   * `ContextMessage`. After participants reply, the `challenge` advisor is
   * invoked over the consensus to surface wrong assumptions.
   *
   * The resulting `fix_task_draft.approval_status` is FORCED to `'pending'`
   * regardless of operator input — operator must explicitly approve via the
   * existing fix-task endpoints. Live council can never auto-promote a draft
   * to executable status.
   *
   * Defaults to false (deterministic legacy behaviour).
   */
  liveMode?: boolean;
  /**
   * F6-4: Optional advisor invoker injected for testing. When omitted, the
   * default registry-based invoker (`runAdvisorViaRegistry`) is used.
   * Mocking this lets unit tests assert advisor fan-out without spinning up
   * Omniroute or the LLM ledger.
   */
  advisorInvoker?: AdvisorInvoker;
}

export type AdvisorInvocationResult = {
  output: string;
  model?: string | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
};

export type AdvisorInvoker = (input: {
  advisorName: string;
  workspace: string;
  workflowId: string;
  prompt: string;
  priorMessages: Array<{ advisor: string; output: string }>;
}) => Promise<AdvisorInvocationResult>;

export interface CouncilFixTaskDraft {
  title: string;
  objective: string;
  acceptance_criteria: string;
  run_mode: 'dry-run';
  source_decision_id: string;
  /**
   * F6-4: Always 'pending' for live-mode drafts. For deterministic council the
   * field is omitted to preserve the legacy shape that downstream tests
   * already pin via JSON.stringify equality.
   */
  approval_status?: 'pending';
}

export interface CouncilRunRecord {
  council_id: string;
  workflow_id: string;
  task_id: string | null;
  status: 'completed';
  run_mode: 'dry-run' | 'approved-run';
  approval_status: 'not_required' | 'approved';
  audit_status: 'recorded';
  thread: ContextThreadRow;
  messages: ContextMessageRow[];
  decision: ContextDecisionRow;
  fix_task_draft: CouncilFixTaskDraft;
  /**
   * F6-4: When liveMode === true, exposes the live verdict + confidence so
   * the dashboard can render a richer card without re-parsing message bodies.
   * Omitted entirely from deterministic council to keep the legacy snapshot
   * shape stable.
   */
  live_verdict?: {
    verdict: 'consensus' | 'split' | 'inconclusive';
    confidence: number;
    challenge_present: boolean;
  };
}

function normalizeParticipant(value: CouncilParticipant): CouncilParticipant {
  const id = value.id.trim().toLowerCase();
  return {
    id: id || 'advisor',
    role: value.role.trim() || id || 'advisor',
  };
}

/**
 * F6-4: Generic adapter that converts a council prompt into the args object
 * the registered advisor expects. Stepwise advisors (codereview, debug,
 * planner, consensus, precommit, thinkdeep) take `step / step_number /
 * total_steps / next_step_required / findings`. One-shot advisors (chat,
 * challenge, refactor, etc.) take `prompt`. We always send a one-shot,
 * single-call invocation — multi-step memory belongs to the advisor's own
 * stepwise loop, not to council fan-out.
 */
function buildAdvisorArgs(advisorName: string, prompt: string): unknown {
  switch (advisorName) {
    case 'challenge':
      return { prompt };
    case 'chat':
      return { prompt };
    case 'codereview':
      return {
        step: prompt,
        step_number: 1,
        total_steps: 1,
        next_step_required: false,
        findings: 'Initial council review — no prior findings.',
        review_validation_type: 'internal',
        mode: 'oneshot',
      };
    case 'debug':
      return {
        step: prompt,
        step_number: 1,
        total_steps: 1,
        next_step_required: false,
        findings: 'Initial council debug pass — no prior findings.',
        confidence: 'exploring',
        mode: 'oneshot',
      };
    case 'planner':
      return {
        step: prompt,
        step_number: 1,
        total_steps: 1,
        next_step_required: false,
        mode: 'oneshot',
      };
    case 'precommit':
    case 'thinkdeep':
    case 'analyze':
    case 'refactor':
    case 'secaudit':
    case 'testgen':
    case 'tracer':
    case 'docgen':
      return {
        step: prompt,
        step_number: 1,
        total_steps: 1,
        next_step_required: false,
        findings: 'Initial council pass — no prior findings.',
        mode: 'oneshot',
      };
    case 'consensus':
      return {
        step: prompt,
        step_number: 1,
        total_steps: 1,
        next_step_required: false,
        findings: 'Initial council consensus pass.',
        mode: 'oneshot',
      };
    case 'apilookup':
    case 'listmodels':
    case 'version':
      return { prompt };
    default:
      // Conservative fallback: try a chat-style envelope; advisor's Zod
      // validator will surface any mismatch as a structured error.
      return { prompt };
  }
}

/**
 * F6-4: Default registry-backed invoker. Resolves the advisor by name and
 * runs it. Captures latency on the wall clock; usage / cost are pulled from
 * the advisor result when present (most stepwise advisors do not populate
 * `usage` today, hence the nullable fields).
 */
async function runAdvisorViaRegistry(input: {
  advisorName: string;
  workspace: string;
  workflowId: string;
  prompt: string;
  priorMessages: Array<{ advisor: string; output: string }>;
}): Promise<AdvisorInvocationResult> {
  const advisor = getAdvisor(input.advisorName);
  if (!advisor) {
    throw new Error(`Live council: advisor '${input.advisorName}' is not registered. ` +
      `Ensure src/v2/advisors/loader.js has been imported before calling createCouncilRun in liveMode.`);
  }
  const ctx: AdvisorContext = {
    workspace: input.workspace,
    workflow_id: input.workflowId,
    mode: 'oneshot',
  };
  const args = buildAdvisorArgs(input.advisorName, buildPromptWithHistory(input.prompt, input.priorMessages));
  const startedAt = Date.now();
  const result: AdvisorResult | StepwiseAdvisorResult = await advisor.run(ctx, args);
  const latencyMs = Date.now() - startedAt;
  return {
    output: result.output,
    model: null,
    cost_usd: result.usage?.cost_usd ?? null,
    latency_ms: latencyMs,
    tokens_in: result.usage?.tokens_in ?? null,
    tokens_out: result.usage?.tokens_out ?? null,
  };
}

function buildPromptWithHistory(
  prompt: string,
  priorMessages: Array<{ advisor: string; output: string }>,
): string {
  if (priorMessages.length === 0) return prompt;
  const lines: string[] = [];
  lines.push('=== PRIOR COUNCIL RESPONSES ===');
  for (const prior of priorMessages) {
    lines.push(`--- ${prior.advisor} ---`);
    lines.push(prior.output);
    lines.push('');
  }
  lines.push('=== YOUR TURN ===');
  lines.push(prompt);
  return lines.join('\n');
}

/**
 * F6-4: Crude but deterministic verdict extractor. Counts positive vs negative
 * sentiment markers across advisor outputs to classify the consensus. Real
 * verdict synthesis can plug in here later (e.g., another LLM call) — keeping
 * this mechanical so unit tests stay reproducible without mocking yet another
 * model.
 */
function synthesizeLiveVerdict(
  outputs: Array<{ advisor: string; output: string }>,
): { verdict: 'consensus' | 'split' | 'inconclusive'; confidence: number } {
  if (outputs.length === 0) return { verdict: 'inconclusive', confidence: 0 };
  let positives = 0;
  let negatives = 0;
  const positiveRe = /\b(approve|approved|safe|proceed|ship|merge|looks good|lgtm|no issues?)\b/i;
  const negativeRe = /\b(reject|block|risky|halt|do not|don't|critical|severe|broken|fail(?:ed|ure)?)\b/i;
  for (const item of outputs) {
    if (positiveRe.test(item.output)) positives += 1;
    if (negativeRe.test(item.output)) negatives += 1;
  }
  if (positives > 0 && negatives === 0) {
    return { verdict: 'consensus', confidence: Math.min(1, positives / outputs.length) };
  }
  if (negatives > 0 && positives === 0) {
    return { verdict: 'consensus', confidence: Math.min(1, negatives / outputs.length) };
  }
  if (positives > 0 && negatives > 0) {
    return { verdict: 'split', confidence: 0.5 };
  }
  return { verdict: 'inconclusive', confidence: 0.25 };
}

export async function createCouncilRunLive(
  db: Database.Database,
  input: CreateCouncilRunInput,
): Promise<CouncilRunRecord> {
  return createCouncilRunInternal(db, { ...input, liveMode: true });
}

export function createCouncilRun(
  db: Database.Database,
  input: CreateCouncilRunInput,
): CouncilRunRecord {
  // F6-4: liveMode requires async because advisor LLM calls return Promises.
  // Surface that constraint loudly — silent dispatch to async would let
  // callers receive a hollow CouncilRunRecord with empty messages.
  if (input.liveMode === true) {
    throw new Error('Live council requires the async createCouncilRunLive() entrypoint. ' +
      'Use `await createCouncilRunLive(db, input)` (or pass liveMode: false / omit it for the deterministic path).');
  }
  // Deterministic path returns synchronously — preserve existing call sites.
  return runDeterministicCouncil(db, input);
}

function runDeterministicCouncil(
  db: Database.Database,
  input: CreateCouncilRunInput,
): CouncilRunRecord {
  const participants = (input.participants.length > 0
    ? input.participants
    : [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
        { id: 'codereview', role: 'code review' },
      ]).map(normalizeParticipant);
  const runMode = input.runMode ?? 'dry-run';
  if (runMode === 'approved-run' && !input.approvedBy?.trim()) {
    throw new Error('approved-run council requires approved_by metadata');
  }

  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = createContextThread(db, {
    channelId: channel.id,
    kind: 'advisor',
    title: `Council: ${input.topic}`,
    runId: input.runId,
    taskId: input.taskId ?? null,
    metadata: {
      council_topic: input.topic,
      source: input.source ?? 'workflow',
      participants,
      run_mode: runMode,
      approval_status: runMode === 'approved-run' ? 'approved' : 'not_required',
      audit_status: 'recorded',
      actor: input.actor ?? 'dashboard',
    },
  });

  const contextSummary = redactContextBody(input.contextSummary ?? 'No additional context summary was supplied.');
  const messages = participants.map((participant, index) =>
    createContextMessage(db, {
      threadId: thread.id,
      senderType: 'advisor',
      senderId: participant.id,
      kind: 'advisor_review',
      body: [
        `Role: ${participant.role}`,
        `Source: ${input.source ?? 'workflow'}`,
        `Topic: ${redactContextBody(input.topic)}`,
        `Position: inspect the supplied workflow evidence, preserve auditability, and prefer dry-run fix tasks before approved writes.`,
        index === 0 ? `Context: ${contextSummary}` : '',
      ].filter(Boolean).join('\n'),
      metadata: {
        eventType: 'council_message',
        participant,
        run_mode: runMode,
      },
    }),
  );

  const rationale = [
    `Council decision for ${input.topic}`,
    `Participants: ${participants.map((p) => `${p.id} (${p.role})`).join(', ')}`,
    `Recommendation: create a dry-run fix task before applying changes; attach this decision to the task thread when relevant.`,
    `Context: ${contextSummary}`,
  ].join('\n');

  const decision = recordContextDecision(db, {
    threadId: thread.id,
    runId: input.runId,
    taskId: input.taskId ?? null,
    kind: 'note',
    status: 'recorded',
    rationale,
    metadata: {
      decision_type: 'council_decision',
      source: input.source ?? 'workflow',
      participants,
      run_mode: runMode,
      approval_status: runMode === 'approved-run' ? 'approved' : 'not_required',
      audit_status: 'recorded',
      actor: input.actor ?? 'dashboard',
      approved_by: input.approvedBy ?? null,
      context_summary: redactContextJson(input.contextSummary ?? ''),
    },
  });

  return {
    council_id: thread.id,
    workflow_id: input.runId,
    task_id: input.taskId ?? null,
    status: 'completed',
    run_mode: runMode,
    approval_status: runMode === 'approved-run' ? 'approved' : 'not_required',
    audit_status: 'recorded',
    thread,
    messages,
    decision,
    fix_task_draft: {
      title: `Apply council decision: ${input.topic}`,
      objective: `Turn council decision ${decision.id} into the smallest safe workflow adjustment.`,
      acceptance_criteria: 'Fix task remains inspectable as dry-run until the operator explicitly approves execution.',
      run_mode: 'dry-run',
      source_decision_id: decision.id,
    },
  };
}

async function createCouncilRunInternal(
  db: Database.Database,
  input: CreateCouncilRunInput,
): Promise<CouncilRunRecord> {
  // Live-mode safety: forbid `approved-run`. Live council writes nothing
  // executable — the operator must explicitly approve the resulting fix-task
  // via the existing fix-task endpoints. Even an "approved-run" caller flag
  // here would be misleading because no execution actually happens.
  const runMode: 'dry-run' = 'dry-run';
  if (input.runMode === 'approved-run') {
    throw new Error('Live council never runs in approved-run; flip back to dry-run and approve the resulting fix-task explicitly.');
  }

  const participants = (input.participants.length > 0
    ? input.participants
    : [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
        { id: 'codereview', role: 'code review' },
      ]).map(normalizeParticipant);

  const channel = ensureRunContextChannel(db, {
    workspace: input.workspace,
    runId: input.runId,
    title: `Run ${input.runId}`,
  });
  const thread = createContextThread(db, {
    channelId: channel.id,
    kind: 'advisor',
    title: `Council (live): ${input.topic}`,
    runId: input.runId,
    taskId: input.taskId ?? null,
    metadata: {
      council_topic: input.topic,
      source: input.source ?? 'workflow',
      participants,
      run_mode: runMode,
      live_mode: true,
      approval_status: 'not_required',
      audit_status: 'recorded',
      actor: input.actor ?? 'dashboard',
    },
  });

  const contextSummary = redactContextBody(input.contextSummary ?? 'No additional context summary was supplied.');
  const invoker = input.advisorInvoker ?? runAdvisorViaRegistry;
  const messages: ContextMessageRow[] = [];
  const liveOutputs: Array<{ advisor: string; output: string }> = [];

  for (const participant of participants) {
    const prompt = [
      `Topic: ${redactContextBody(input.topic)}`,
      `Source: ${input.source ?? 'workflow'}`,
      `Role: ${participant.role}`,
      `Context: ${contextSummary}`,
      'Provide a concise position from your role. Identify risks, recommended action, and any open questions.',
    ].join('\n');

    let invocation: AdvisorInvocationResult;
    try {
      invocation = await invoker({
        advisorName: participant.id,
        workspace: input.workspace,
        workflowId: input.runId,
        prompt,
        priorMessages: [...liveOutputs],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const message = createContextMessage(db, {
        threadId: thread.id,
        senderType: 'advisor',
        senderId: participant.id,
        kind: 'advisor_review',
        body: `Live advisor invocation failed for '${participant.id}': ${redactContextBody(reason)}`,
        metadata: {
          eventType: 'council_live_message',
          participant,
          run_mode: runMode,
          error: true,
          live_mode: true,
        },
      });
      messages.push(message);
      // Continue with remaining participants — partial council is still
      // useful evidence and pending fix-task remains required for any action.
      continue;
    }

    const message = createContextMessage(db, {
      threadId: thread.id,
      senderType: 'advisor',
      senderId: participant.id,
      kind: 'advisor_review',
      body: invocation.output,
      metadata: {
        eventType: 'council_live_message',
        participant,
        run_mode: runMode,
        live_mode: true,
        model: invocation.model ?? null,
        cost_usd: invocation.cost_usd ?? null,
        latency_ms: invocation.latency_ms ?? null,
        tokens_in: invocation.tokens_in ?? null,
        tokens_out: invocation.tokens_out ?? null,
      },
    });
    messages.push(message);
    liveOutputs.push({ advisor: participant.id, output: invocation.output });
  }

  // Challenge advisor pass — only when at least one participant succeeded
  // AND the operator did not already include challenge in the panel.
  const alreadyHasChallenge = participants.some((p) => p.id === 'challenge');
  let challengePresent = false;
  if (liveOutputs.length > 0 && !alreadyHasChallenge) {
    const challengePrompt = [
      `Council reviewed: ${redactContextBody(input.topic)}`,
      `Participants: ${participants.map((p) => p.id).join(', ')}`,
      'Below are their positions. Identify wrong assumptions, missing evidence, or premature conclusions. ',
      'Be terse and specific.',
      '',
      ...liveOutputs.map((o) => `--- ${o.advisor} ---\n${o.output}`),
    ].join('\n');
    try {
      const challengeResult = await invoker({
        advisorName: 'challenge',
        workspace: input.workspace,
        workflowId: input.runId,
        prompt: challengePrompt,
        priorMessages: [...liveOutputs],
      });
      const challengeMessage = createContextMessage(db, {
        threadId: thread.id,
        senderType: 'advisor',
        senderId: 'challenge',
        kind: 'advisor_review',
        body: challengeResult.output,
        metadata: {
          eventType: 'council_live_challenge',
          participant: { id: 'challenge', role: 'challenger' },
          run_mode: runMode,
          live_mode: true,
          model: challengeResult.model ?? null,
          cost_usd: challengeResult.cost_usd ?? null,
          latency_ms: challengeResult.latency_ms ?? null,
        },
      });
      messages.push(challengeMessage);
      challengePresent = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const challengeMessage = createContextMessage(db, {
        threadId: thread.id,
        senderType: 'advisor',
        senderId: 'challenge',
        kind: 'advisor_review',
        body: `Challenge advisor invocation failed: ${redactContextBody(reason)}`,
        metadata: {
          eventType: 'council_live_challenge',
          run_mode: runMode,
          live_mode: true,
          error: true,
        },
      });
      messages.push(challengeMessage);
    }
  } else if (alreadyHasChallenge) {
    challengePresent = true; // operator already had challenge in the panel
  }

  const verdictSummary = synthesizeLiveVerdict(liveOutputs);

  const rationale = [
    `Live council decision for ${input.topic}`,
    `Participants: ${participants.map((p) => `${p.id} (${p.role})`).join(', ')}`,
    `Verdict: ${verdictSummary.verdict} (confidence: ${verdictSummary.confidence.toFixed(2)})`,
    challengePresent ? 'Challenge advisor reviewed positions for wrong assumptions.' : 'No challenge advisor pass performed.',
    `Recommendation: review the pending fix task draft; nothing is executable until the operator explicitly approves it.`,
    `Context: ${contextSummary}`,
  ].join('\n');

  const decision = recordContextDecision(db, {
    threadId: thread.id,
    runId: input.runId,
    taskId: input.taskId ?? null,
    kind: 'note',
    status: 'recorded',
    rationale,
    metadata: {
      decision_type: 'council_decision',
      live_mode: true,
      verdict: verdictSummary.verdict,
      confidence: verdictSummary.confidence,
      challenge_present: challengePresent,
      source: input.source ?? 'workflow',
      participants,
      run_mode: runMode,
      approval_status: 'not_required',
      audit_status: 'recorded',
      actor: input.actor ?? 'dashboard',
      approved_by: null,
      context_summary: redactContextJson(input.contextSummary ?? ''),
    },
  });

  // CRITICAL safety invariant (F6-4): live-mode draft is always 'pending'.
  // Operator must explicitly approve via the fix-task endpoints before any
  // execution path can pick this up. Do NOT relax this for any caller — the
  // CreateCouncilRunInput type carries no field that can override 'pending'.
  return {
    council_id: thread.id,
    workflow_id: input.runId,
    task_id: input.taskId ?? null,
    status: 'completed',
    run_mode: runMode,
    approval_status: 'not_required',
    audit_status: 'recorded',
    thread,
    messages,
    decision,
    fix_task_draft: {
      title: `Apply council decision: ${input.topic}`,
      objective: `Turn live council decision ${decision.id} into the smallest safe workflow adjustment.`,
      acceptance_criteria: 'Fix task remains inspectable as dry-run until the operator explicitly approves execution. Live council never auto-promotes.',
      run_mode: 'dry-run',
      source_decision_id: decision.id,
      approval_status: 'pending',
    },
    live_verdict: {
      verdict: verdictSummary.verdict,
      confidence: verdictSummary.confidence,
      challenge_present: challengePresent,
    },
  };
}
