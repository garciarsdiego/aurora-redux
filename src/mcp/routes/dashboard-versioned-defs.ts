// Dashboard versioned-definitions API routes.
//
// HTTP wrapper around the versioned governance registry (migration 013) so the
// Aurora dashboard can list versioned definitions and pin a version active.
// Registration stays MCP-only (omniforge_register_versioned_definition) —
// matching the empty-state copy in VersionedDefs.tsx.
//
// All routes are Bearer-auth gated upstream by the HTTP server.
//
// Routes:
//   GET  /api/dashboard/versioned-defs            — list summaries (bare array)
//   POST /api/dashboard/versioned-defs/:id/pin    — pin a version active
//
// Response shapes are intentionally a thin summary (no spec/checksum/notes) and
// reconciled to the frontend's VersionedDefSummary type:
//   - version: registry stores semver string; FE wants a number. We send the
//     MAJOR version as an integer (Number.parseInt(version.split('.')[0])).
//   - status: derived from the active_version_pins join + registry status enum.
//     pinned (this row is the active pin) > archived (status archived/deprecated)
//     > active (everything else).
//   - created_at: registry stores epoch ms; FE wants an ISO string.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import {
  listVersionedDefinitions,
  pinVersionedDefinition,
  getDefinitionById,
  type VersionedDefinition,
  type VersionedDefinitionKind,
} from '../../v2/governance/versioned-registry.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound } from './_shared.js';

// ── Path pattern ─────────────────────────────────────────────────────────────

const PIN_RE = /^\/api\/dashboard\/versioned-defs\/([^/]+)\/pin$/;

const KINDS: ReadonlyArray<VersionedDefinitionKind> = ['agent', 'tool', 'policy'];

// ── Reconciled summary shape returned to the dashboard ─────────────────────────

interface VersionedDefSummary {
  id: string;
  name: string;
  kind: VersionedDefinitionKind;
  version: number;
  status: 'active' | 'pinned' | 'archived';
  workspace: string;
  created_at: string;
}

/** Parse the major component of a semver-like string to an integer. */
function majorVersion(version: string): number {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

/**
 * Maps a registry VersionedDefinition + the set of pinned version ids onto the
 * FE summary shape. `pinnedIds` is the set of versioned_definitions.id values
 * that are the active pin for their (workspace, kind, name) tuple.
 */
function toSummary(def: VersionedDefinition, pinnedIds: Set<string>): VersionedDefSummary {
  let status: VersionedDefSummary['status'];
  if (pinnedIds.has(def.id)) {
    status = 'pinned';
  } else if (def.status === 'archived' || def.status === 'deprecated') {
    status = 'archived';
  } else {
    status = 'active';
  }
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    version: majorVersion(def.version),
    status,
    workspace: def.workspace,
    created_at: new Date(def.created_at).toISOString(),
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(url: URL, res: ServerResponse): void {
  const workspaceParam = url.searchParams.get('workspace') ?? undefined;
  const kindParam = url.searchParams.get('kind') ?? undefined;
  const nameParam = url.searchParams.get('name') ?? undefined;

  if (kindParam && !KINDS.includes(kindParam as VersionedDefinitionKind)) {
    badRequest(res, `kind must be one of: ${KINDS.join(', ')}`);
    return;
  }

  const db = initDb(getDbPath());
  try {
    const defs = listVersionedDefinitions(db, {
      workspace: workspaceParam,
      kind: kindParam as VersionedDefinitionKind | undefined,
      name: nameParam,
      limit: 100,
    });

    // Build the set of pinned version ids so status derivation is a cheap lookup.
    const pinnedRows = db
      .prepare(`SELECT version_id FROM active_version_pins`)
      .all() as Array<{ version_id: string }>;
    const pinnedIds = new Set(pinnedRows.map((r) => r.version_id));

    const summaries = defs.map((def) => toSummary(def, pinnedIds));
    // Bare JSON array (no envelope) — the FE request<T> helper does NOT unwrap.
    jsonOk(res, summaries);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handlePin(id: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    // The FE only sends a bare id, but pinVersionedDefinition needs the full
    // (workspace, kind, name) tuple — recover it from the row.
    const def = getDefinitionById(db, id);
    if (!def) {
      notFound(res, `Versioned definition not found: ${id}`);
      return;
    }

    try {
      withSqliteRetrySync(() =>
        pinVersionedDefinition(db, {
          workspace: def.workspace,
          kind: def.kind,
          name: def.name,
          versionId: id,
          pinnedBy: 'dashboard',
        }),
      );
    } catch (pinErr) {
      // pinVersionedDefinition throws on workspace/kind/name mismatch — surface
      // as 400 rather than 500 since it is a client-recoverable condition.
      // Not a workflow-scoped failure, so log to stderr (insertEvent requires a
      // workflow_id FK) instead of silently swallowing.
      process.stderr.write(
        `[daemon] versioned-def pin failed for ${id}: ${pinErr instanceof Error ? pinErr.message : String(pinErr)}\n`,
      );
      badRequest(res, pinErr instanceof Error ? pinErr.message : String(pinErr));
      return;
    }

    jsonOk(res, { ok: true });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// ── Router export ─────────────────────────────────────────────────────────────

export const dashboardVersionedDefsRouter: Router = async (req, url, res) => {
  // GET /api/dashboard/versioned-defs[?workspace=&kind=&name=]
  if (req.method === 'GET' && url.pathname === '/api/dashboard/versioned-defs') {
    handleList(url, res);
    return true;
  }

  // POST /api/dashboard/versioned-defs/:id/pin
  if (req.method === 'POST') {
    const pinMatch = url.pathname.match(PIN_RE);
    if (pinMatch) {
      handlePin(pinMatch[1]!, res);
      return true;
    }
  }

  return false;
};
