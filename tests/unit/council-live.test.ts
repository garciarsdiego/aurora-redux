/**
 * F6-4: live council unit tests.
 *
 * Verifies:
 *  - liveMode === true (via createCouncilRunLive) invokes the supplied
 *    advisor invoker once per participant, persists each reply as a
 *    ContextMessage, then runs `challenge` over the consensus.
 *  - The synthesized decision carries verdict + confidence in metadata.
 *  - The fix-task draft is ALWAYS approval_status='pending' (the safety
 *    invariant that operator approval is still required).
 *  - liveMode === false (or omitted) preserves the legacy deterministic
 *    behaviour — exact-shape equality on the existing fields.
 *  - createCouncilRun rejects an attempt to opt-into live mode synchronously
 *    (must use the async createCouncilRunLive entrypoint).
 *  - approved-run is rejected for live council.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createCouncilRun,
  createCouncilRunLive,
  type AdvisorInvocationResult,
  type AdvisorInvoker,
} from '../../src/context/council.js';
import { runLiveCouncil } from '../../src/context/advisors.js';
import { loadThreadMessages } from '../../src/context/store.js';
import { initDb } from '../../src/db/client.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';

function insertWorkflow(db: ReturnType<typeof initDb>, id = 'wf_council_live'): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES (?, 'internal', 'live council smoke', 'executing', ?, NULL, ?, 'test')`,
  ).run(id, now, now);
}

function buildCannedInvoker(replies: Record<string, string>): AdvisorInvoker {
  // Per-advisor canned reply. Returns a stable AdvisorInvocationResult so the
  // metadata persistence path can be asserted from the resulting messages.
  return vi.fn(async ({ advisorName }: { advisorName: string }): Promise<AdvisorInvocationResult> => {
    const reply = replies[advisorName] ?? `Fallback reply for ${advisorName}.`;
    return {
      output: reply,
      model: `mock/${advisorName}`,
      cost_usd: 0.0001,
      latency_ms: 42,
      tokens_in: 10,
      tokens_out: 20,
    };
  });
}

describe('live council (F6-4)', () => {
  it('invokes 3 participants, persists their messages + a challenge pass + 1 pending fix-task', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db);

    const invoker = buildCannedInvoker({
      // Verdict synthesizer counts positive vs negative sentiment markers.
      // Keep the participant outputs cleanly positive so the test stays
      // deterministic — phrases like "no critical errors" would trigger the
      // negative branch via the word "critical".
      planner: 'Planner: scope is well-defined; safe to proceed.',
      debug: 'Debug: no defects observed; safe to ship.',
      codereview: 'Codereview: looks good — approve.',
      // Challenger output is intentionally NOT counted by synthesizeLiveVerdict
      // (only participant outputs feed the verdict), so any wording is fine.
      challenge: 'Challenger: assumption A is unverified; gather evidence before merging.',
    });

    const result = await createCouncilRunLive(db, {
      workspace: 'internal',
      runId: 'wf_council_live',
      taskId: 'tk_alpha',
      topic: 'Decide whether to merge the persistence patch',
      source: 'quality_review',
      participants: [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
        { id: 'codereview', role: 'code review' },
      ],
      contextSummary: 'Patch touches src/db/persist.ts; tests are green; one TODO remains.',
      advisorInvoker: invoker,
    });

    // 3 participants + 1 challenge advisor = 4 messages.
    expect(invoker).toHaveBeenCalledTimes(4);
    expect(result.messages).toHaveLength(4);
    const senderIds = result.messages.map((m) => m.sender_id);
    expect(senderIds).toEqual(['planner', 'debug', 'codereview', 'challenge']);

    // Each persisted message should carry advisor metadata.
    for (const msg of result.messages.slice(0, 3)) {
      const meta = JSON.parse(msg.metadata_json) as Record<string, unknown>;
      expect(meta['live_mode']).toBe(true);
      expect(meta['model']).toMatch(/^mock\//);
      expect(meta['latency_ms']).toBe(42);
    }

    // Challenge metadata is tagged distinctly so the dashboard can render it
    // as a "Challenger" pill instead of a regular participant card.
    const challengeMeta = JSON.parse(result.messages[3]!.metadata_json) as Record<string, unknown>;
    expect(challengeMeta['eventType']).toBe('council_live_challenge');

    // Decision metadata holds verdict + confidence so consumers don't have to
    // re-parse the rationale text.
    const decisionMeta = JSON.parse(result.decision.metadata_json) as Record<string, unknown>;
    expect(decisionMeta['live_mode']).toBe(true);
    expect(decisionMeta['challenge_present']).toBe(true);
    expect(decisionMeta['verdict']).toBe('consensus');
    expect(typeof decisionMeta['confidence']).toBe('number');

    // SAFETY invariant: pending fix-task draft, never approved or executable.
    expect(result.fix_task_draft.approval_status).toBe('pending');
    expect(result.fix_task_draft.run_mode).toBe('dry-run');
    expect(result.fix_task_draft.source_decision_id).toBe(result.decision.id);

    // live_verdict surface is exposed for the dashboard live-council card.
    expect(result.live_verdict?.verdict).toBe('consensus');
    expect(result.live_verdict?.challenge_present).toBe(true);

    // run_mode + approval_status on the council itself reflect dry-run.
    expect(result.run_mode).toBe('dry-run');
    expect(result.approval_status).toBe('not_required');

    // Thread messages persisted in the order they were invoked.
    const persisted = loadThreadMessages(db, result.thread.id).map((m) => m.sender_id);
    expect(persisted).toEqual(['planner', 'debug', 'codereview', 'challenge']);

    db.close();
  });

  it('redacts secrets from the live context summary in persisted records', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_secret_live');

    const invoker = buildCannedInvoker({
      planner: 'Planner: nothing concerning.',
    });

    const result = await createCouncilRunLive(db, {
      workspace: 'internal',
      runId: 'wf_secret_live',
      topic: 'Token rotation review',
      participants: [{ id: 'planner', role: 'planner' }],
      contextSummary: 'token=secretXYZ123 should be rotated',
      advisorInvoker: invoker,
    });

    const log = JSON.stringify(buildWorkflowDebugLog(db, 'wf_secret_live'));
    expect(log).toContain('rotated');
    expect(log).not.toContain('secretXYZ123');
    // Drafts are still pending.
    expect(result.fix_task_draft.approval_status).toBe('pending');

    db.close();
  });

  it('does NOT add a challenge pass when challenge is already in the participant panel', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_challenge_in_panel');

    const invoker = buildCannedInvoker({
      planner: 'Planner: ok.',
      challenge: 'Challenger: any blind spots?',
    });

    const result = await createCouncilRunLive(db, {
      workspace: 'internal',
      runId: 'wf_challenge_in_panel',
      topic: 'No double challenge',
      participants: [
        { id: 'planner', role: 'planner' },
        { id: 'challenge', role: 'challenger' },
      ],
      advisorInvoker: invoker,
    });

    // 2 participants only — no automatic challenge appended.
    expect(invoker).toHaveBeenCalledTimes(2);
    expect(result.messages).toHaveLength(2);
    const senderIds = result.messages.map((m) => m.sender_id);
    expect(senderIds).toEqual(['planner', 'challenge']);

    // challenge_present is still true (operator put it in).
    const decisionMeta = JSON.parse(result.decision.metadata_json) as Record<string, unknown>;
    expect(decisionMeta['challenge_present']).toBe(true);

    db.close();
  });

  it('keeps the deterministic legacy shape when liveMode is false / omitted', () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_council_legacy');

    const result = createCouncilRun(db, {
      workspace: 'internal',
      runId: 'wf_council_legacy',
      taskId: 'tk_legacy',
      topic: 'Legacy deterministic council',
      source: 'workflow',
      participants: [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
      ],
      contextSummary: 'Legacy path — no LLM calls.',
      // liveMode omitted intentionally.
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.sender_id)).toEqual(['planner', 'debug']);
    // Legacy fix_task_draft.approval_status is not set (back-compat with the
    // pre-F6-4 snapshot tests in context-council.test.ts).
    expect(result.fix_task_draft.approval_status).toBeUndefined();
    expect(result.fix_task_draft.run_mode).toBe('dry-run');
    // No live_verdict surface in deterministic path.
    expect(result.live_verdict).toBeUndefined();
    // No live_mode flag in decision metadata.
    const meta = JSON.parse(result.decision.metadata_json) as Record<string, unknown>;
    expect(meta['live_mode']).toBeUndefined();

    db.close();
  });

  it('createCouncilRun (sync) refuses liveMode=true and points the caller at the async entrypoint', () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_sync_refuses_live');

    expect(() => createCouncilRun(db, {
      workspace: 'internal',
      runId: 'wf_sync_refuses_live',
      topic: 'Should refuse',
      participants: [{ id: 'planner', role: 'planner' }],
      liveMode: true,
    })).toThrow(/createCouncilRunLive/);

    db.close();
  });

  it('refuses approved-run for live council', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_live_refuses_approved');

    await expect(createCouncilRunLive(db, {
      workspace: 'internal',
      runId: 'wf_live_refuses_approved',
      topic: 'Should refuse',
      participants: [{ id: 'planner', role: 'planner' }],
      runMode: 'approved-run',
      approvedBy: 'operator',
    })).rejects.toThrow(/approved-run/);

    db.close();
  });

  it('runLiveCouncil convenience wrapper threads through the same invoker contract', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_live_wrapper');

    const invoker = buildCannedInvoker({
      planner: 'Planner: proceed.',
      debug: 'Debug: no errors.',
      codereview: 'Codereview: approve.',
      challenge: 'Challenger: any missing tests?',
    });

    const result = await runLiveCouncil(db, {
      workspace: 'internal',
      runId: 'wf_live_wrapper',
      topic: 'Wrapper smoke',
      participants: [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
        { id: 'codereview', role: 'code review' },
      ],
      advisorInvoker: invoker,
    });

    expect(result.messages).toHaveLength(4);
    expect(result.fix_task_draft.approval_status).toBe('pending');
    expect(invoker).toHaveBeenCalledTimes(4);

    db.close();
  });

  it('continues council when one participant invocation fails — failure is recorded as an error message', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_partial_failure');

    const invoker: AdvisorInvoker = vi.fn(async ({ advisorName }) => {
      if (advisorName === 'debug') {
        throw new Error('debug LLM unavailable');
      }
      return {
        output: `Reply from ${advisorName}.`,
        model: `mock/${advisorName}`,
        cost_usd: 0,
        latency_ms: 1,
        tokens_in: 0,
        tokens_out: 0,
      };
    });

    const result = await createCouncilRunLive(db, {
      workspace: 'internal',
      runId: 'wf_partial_failure',
      topic: 'Partial failure smoke',
      participants: [
        { id: 'planner', role: 'planner' },
        { id: 'debug', role: 'debug' },
        { id: 'codereview', role: 'code review' },
      ],
      advisorInvoker: invoker,
    });

    // 3 participants attempted (1 errored) + 1 challenge over the 2 surviving outputs.
    expect(invoker).toHaveBeenCalledTimes(4);
    expect(result.messages).toHaveLength(4);
    const debugMessage = result.messages.find((m) => m.sender_id === 'debug');
    expect(debugMessage?.body).toContain('debug LLM unavailable');
    const debugMeta = JSON.parse(debugMessage!.metadata_json) as Record<string, unknown>;
    expect(debugMeta['error']).toBe(true);
    // Pending fix-task is still emitted so the operator can decide what to do.
    expect(result.fix_task_draft.approval_status).toBe('pending');

    db.close();
  });
});
