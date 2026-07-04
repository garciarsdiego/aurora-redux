import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { resolveHitlGate } from '../../db/persist.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import { getDbPath } from '../../utils/config.js';

export const ApproveGateSchema = z.object({
  gate_id: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'modify']),
  feedback: z.string().optional(),
});

interface GateStatusRow {
  id: string;
  status: string;
  context_json: string | null;
}

/** Maps MCP-friendly decision names to DB values. */
const DECISION_MAP = {
  approve: 'approved',
  reject: 'rejected',
  modify: 'modify',
} as const;

export async function approveGateTool(raw: unknown): Promise<string> {
  const { gate_id, decision, feedback } = ApproveGateSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const row = db
      .prepare('SELECT id, status, context_json FROM hitl_gates WHERE id = ?')
      .get(gate_id) as GateStatusRow | undefined;

    if (!row) {
      return JSON.stringify({ error: `Gate not found: ${gate_id}` });
    }

    if (row.status !== 'pending') {
      return JSON.stringify({ error: `Gate already resolved: ${row.status}` });
    }

    const resolvedDecision = DECISION_MAP[decision];
    resolveHitlGate(db, gate_id, resolvedDecision);

    if (feedback) {
      // Merge feedback into context_json so it's auditable without schema change
      const existing = row.context_json ? (JSON.parse(row.context_json) as Record<string, unknown>) : {};
      const updated = { ...existing, mcp_feedback: feedback };
      withSqliteRetrySync(() =>
        db.prepare('UPDATE hitl_gates SET context_json = ? WHERE id = ?').run(
          JSON.stringify(updated),
          gate_id,
        ),
      );
    }

    return JSON.stringify({ gate_id, decision: resolvedDecision, resolved: true });
  } finally {
    db.close();
  }
}
