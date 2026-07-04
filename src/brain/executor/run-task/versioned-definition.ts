import type Database from 'better-sqlite3';
import { insertEvent } from '../../../db/persist.js';
import {
  getActiveVersionedDefinition,
  recordVersionedDefinitionUsage,
} from '../../../v2/governance/versioned-registry.js';

/**
 * Tier 0 Wave 3 (ITEM 0.7) — versioned definitions consumption.
 *
 * Inspects the version registry for a pinned agent/persona before runtime
 * dispatch. When a pin exists, emits a versioned_definition_consumed event
 * + records usage so audits can replay which spec drove which task. Returns
 * the pinned definition (or null) so the caller can apply spec overrides.
 *
 * Safe for cold paths: the registry table exists from migration 037+. Any
 * unexpected DB error is swallowed (best-effort observability — the audit
 * trail is a help, not a contract that can block execution).
 */
export function consumeVersionedDefinition(
  db: Database.Database,
  params: {
    workspace: string;
    kind: 'agent' | 'tool' | 'policy';
    name: string;
    workflowId: string;
    taskId?: string;
    role: string;
  },
): { spec: unknown; version: string; id: string } | null {
  try {
    const def = getActiveVersionedDefinition(db, {
      workspace: params.workspace,
      kind: params.kind,
      name: params.name,
    });
    if (!def) return null;
    insertEvent(db, {
      workflow_id: params.workflowId,
      task_id: params.taskId ?? null,
      type: 'versioned_definition_consumed',
      payload: {
        kind: params.kind,
        name: params.name,
        version: def.version,
        definition_id: def.id,
        workspace: params.workspace,
        role: params.role,
      },
    });
    try {
      recordVersionedDefinitionUsage(db, {
        workflowId: params.workflowId,
        ...(params.taskId ? { taskId: params.taskId } : {}),
        definitionId: def.id,
        role: params.role,
      });
    } catch {
      // Usage row is audit-only — never block execution if the insert fails
      // (FK constraints, schema drift on legacy DBs). The consumed event
      // above is the primary observability signal.
    }
    return { spec: def.spec, version: def.version, id: def.id };
  } catch {
    return null;
  }
}
