// Sprint 4.4 (D-H2.066): GET endpoints + workspace/planner CRUD + admin clear.
//
// All POST-AUTH. Read endpoints feed the Studio sidepanels; workspace and
// planner-sessions CRUD persist user state in SQLite (dashboard_workspaces,
// dashboard_planner_sessions tables added in migrations 018/019).

import type { ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { initDb } from '../../db/client.js';
import {
  getDaemonState,
  setDaemonState,
  getCostByModel,
  getCostByTask,
  getCostSummary,
  getRemediationForWorkflow,
  loadWorkflowById,
} from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import type { DashboardRunCostResponse } from '../../types/index.js';
import { buildDashboardSnapshot } from '../dashboard-data.js';
import { listDashboardDags } from '../dashboard-dag-ops.js';
import {
  clearDashboardData,
  createDashboardWorkspace,
  openProjectRoot,
  updateDashboardWorkspace,
  validateProjectRoot,
  type ProjectRootStructuredError,
} from '../dashboard-workspace-ops.js';
import {
  deleteDashboardPlannerSession,
  listDashboardPlannerSessions,
  renameDashboardPlannerSession,
  upsertDashboardPlannerSession,
} from '../dashboard-planner-sessions.js';
import { routeModelTool } from '../tools/route_model.js';
import { setConfigTool } from '../tools/set_config.js';
import { ADVISOR_NAMES } from '../tools/advisor_tools.js';
import type { AdvisorMode } from '../../v2/advisors/types.js';
import { isAdvisorMode } from '../../v2/advisors/shared/mode.js';
import {
  normalizeAutoTagOverrides,
  setRuntimeAutoTagOverrides,
  type AutoTagOverrides,
} from '../../v2/models/auto-tags.js';
import {
  getAdaptiveMaxIterations,
  getMaxLlmStreamsPerActor,
  getMaxParallelTasks,
  getMaxPlanModifications,
} from '../../utils/config.js';
import { loadCatalog as loadOmnirouteCatalog } from '../../repl/services/modelCatalog.js';
import { getDisabledProviders } from '../../utils/setup-config.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readBodyOr400, readLargeJsonBody } from './_shared.js';
// Sprint F4 (Plan/Build/Discuss): single-task runner used by the Composer
// when the operator picks Build or Discuss instead of Plan. Lives in a
// separate ops module so the synthesis logic (DAG construction per
// mode) stays out of this router file.
import { runDashboardSingleTask } from '../dashboard-single-task-ops.js';
import { getWorkflowBudgetUsd } from '../../v2/budget/control.js';

const ADVISOR_MODES_KEY = 'advisor_modes';
const AUTO_TAG_OVERRIDES_KEY = 'auto_tag_overrides';
const ADVISOR_NAME_SET = new Set<string>(ADVISOR_NAMES);

interface TraceSpanTreeRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  attributes_json: string;
}

interface DashboardTraceSpanNode {
  span_id: string;
  name: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  attributes_json: string;
  children: DashboardTraceSpanNode[];
}

function spanRowToNode(row: TraceSpanTreeRow): DashboardTraceSpanNode {
  return {
    span_id: row.id,
    name: row.name,
    kind: row.kind,
    started_at: row.started_at,
    ended_at: row.ended_at,
    attributes_json: row.attributes_json,
    children: [],
  };
}

export function buildDashboardTraceTree(db: Database.Database, workflowId: string): Record<string, unknown> {
  const rows = db
    .prepare(
      `SELECT id, workflow_id, task_id, parent_span_id, name, kind,
              started_at, ended_at, duration_ms, attributes_json
         FROM trace_spans
        WHERE workflow_id = ?
        ORDER BY started_at ASC`,
    )
    .all(workflowId) as TraceSpanTreeRow[];

  if (rows.length === 0) {
    return { trace_id: workflowId, total_spans: 0 };
  }

  const nodes = new Map<string, DashboardTraceSpanNode>();
  for (const row of rows) {
    nodes.set(row.id, spanRowToNode(row));
  }

  const rootCandidates: DashboardTraceSpanNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parent = row.parent_span_id ? nodes.get(row.parent_span_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      rootCandidates.push(node);
    }
  }

  const rootSpan = rootCandidates[0] ?? nodes.get(rows[0]?.id ?? '');
  if (!rootSpan) {
    return { trace_id: workflowId, total_spans: 0 };
  }
  for (const extraRoot of rootCandidates.slice(1)) {
    rootSpan.children.push(extraRoot);
  }

  const firstStartedAt = rows[0]?.started_at ?? 0;
  const lastEndedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.ended_at ?? row.started_at),
    firstStartedAt,
  );

  return {
    trace_id: rows[0]?.workflow_id ?? workflowId,
    root_span: rootSpan,
    total_spans: rows.length,
    duration_ms: Math.max(0, (rootSpan.ended_at ?? lastEndedAt) - rootSpan.started_at),
  };
}

function handleDashboardSummary(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const db = initDb(getDbPath());
  try {
    const snapshot = buildDashboardSnapshot(db, {
      ...(workspace ? { workspace } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    jsonOk(res, snapshot);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardRunTrace(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    jsonOk(res, buildDashboardTraceTree(db, workflowId));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardDagList(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const db = initDb(getDbPath());
  try {
    jsonOk(res, {
      dags: listDashboardDags(db, {
        ...(workspace ? { workspace } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

/**
 * W2 (2026-05-11): expose parent ↔ remediation-child linkage so the
 * dashboard can render the "Awaiting remediation → child" link. Body
 * shape is intentionally minimal — only the data the RunList row needs.
 *
 * GET /api/dashboard/runs/:wfId/remediation
 * Returns:
 *   {
 *     parent_workflow_id: string | null,     // when this is itself a child
 *     remediation: { child_workflow_id, status } | null   // when this has one
 *   }
 */
function handleDashboardRunRemediation(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const wf = loadWorkflowById(db, workflowId);
    if (!wf) {
      badRequest(res, `Workflow ${workflowId} not found`);
      return;
    }
    // Sibling row: this workflow's own parent_workflow_id (when it's a child).
    const parentRow = db
      .prepare(`SELECT parent_workflow_id FROM workflows WHERE id = ?`)
      .get(workflowId) as { parent_workflow_id: string | null } | undefined;
    const child = getRemediationForWorkflow(db, workflowId);
    jsonOk(res, {
      parent_workflow_id: parentRow?.parent_workflow_id ?? null,
      remediation: child
        ? { child_workflow_id: child.childWfId, status: child.status }
        : null,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardRunCost(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const body: DashboardRunCostResponse = {
      summary: getCostSummary(db, workflowId),
      byTask: getCostByTask(db, workflowId),
      byModel: getCostByModel(db, workflowId),
      cap: getWorkflowBudgetUsd(),
      currency: 'USD',
      generated_at: new Date().toISOString(),
    };
    jsonOk(res, body);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardWorkspaceCreate(body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    jsonOk(res, createDashboardWorkspace(db, body));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardWorkspaceUpdate(workspace: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    jsonOk(res, { workspace, profile: updateDashboardWorkspace(db, workspace, body) });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// F4-9: validate a project root path before AskScreen submits a Plan/Build/
// Discuss run. Returns 200 with `{ validation }` even when invalid — the
// frontend reads `validation.valid` and surfaces structured errors. We use
// 200-with-payload (rather than 400) because the path being invalid is the
// expected outcome the form is trying to detect, not a transport error.
function handleDashboardWorkspaceValidateRoot(body: unknown, res: ServerResponse): void {
  try {
    jsonOk(res, { validation: validateProjectRoot(body) });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// F4-9: open the project root in the OS file browser. 400 with structured
// error if the path is invalid (delegates to validateProjectRoot).
function handleDashboardWorkspaceOpenRoot(body: unknown, res: ServerResponse): void {
  try {
    jsonOk(res, openProjectRoot(body));
  } catch (err) {
    const structured = (err as { structured?: ProjectRootStructuredError }).structured;
    const message = err instanceof Error ? err.message : String(err);
    if (structured) {
      badRequest(res, message, { structured_error: structured });
    } else {
      badRequest(res, message);
    }
  }
}

function handleDashboardDataClear(body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    jsonOk(res, clearDashboardData(db, body));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardPlannerSessions(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const db = initDb(getDbPath());
  try {
    jsonOk(res, {
      sessions: listDashboardPlannerSessions(db, {
        ...(workspace ? { workspace } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDashboardPlannerSessionSave(body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, upsertDashboardPlannerSession(db, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardPlannerSessionRename(sessionId: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, renameDashboardPlannerSession(db, sessionId, body)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardPlannerSessionDelete(sessionId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, deleteDashboardPlannerSession(db, sessionId)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

async function handleDashboardModels(url: URL, res: ServerResponse): Promise<void> {
  try {
    const capabilities = url.searchParams.get('capabilities');
    const text = await routeModelTool({
      use_case: url.searchParams.get('use_case') ?? undefined,
      provider: url.searchParams.get('provider') ?? undefined,
      strategy: url.searchParams.get('strategy') ?? undefined,
      required_capabilities: capabilities
        ? capabilities.split(',').map((item) => item.trim()).filter(Boolean)
        : undefined,
      limit: Number.parseInt(url.searchParams.get('limit') ?? '8', 10),
    });
    jsonOk(res, JSON.parse(text) as Record<string, unknown>);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

async function handleDashboardModelCatalog(url: URL, res: ServerResponse): Promise<void> {
  try {
    const force = url.searchParams.get('force') === 'true';
    const catalog = await loadOmnirouteCatalog({ force });
    jsonOk(res, {
      models: catalog.models.map((model) => ({
        model_id: model.model_id,
        provider: model.provider,
        provider_display: catalog.providers.find((provider) => provider.id === model.provider)?.displayName ?? model.provider,
        kind: model.kind,
        source: model.source,
        ...(model.tier ? { tier: model.tier } : {}),
        ...(model.use_primary ? { use_primary: model.use_primary } : {}),
        ...(model.use_secondary ? { use_secondary: model.use_secondary } : {}),
        ...(model.score_primary ? { score_primary: model.score_primary } : {}),
        ...(model.score_secondary ? { score_secondary: model.score_secondary } : {}),
        ...(model.eq_ref ? { eq_ref: model.eq_ref } : {}),
      })),
      providers: catalog.providers,
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      total: catalog.models.length,
      ...(catalog.liveError ? { liveError: catalog.liveError } : {}),
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Sprint F4 (model picker): GET /api/models — flat, lightweight model list for
 * the Composer's ModelPicker. Reuses the same Omniroute catalog loader as
 * /api/dashboard/model-catalog (no separate caching layer) but returns a
 * narrower shape tailored to the picker:
 *   { models: Array<{ id, provider, provider_display, kind, tier?,
 *                    description?, recommended_for? }> }
 *
 * The dashboard wraps this in a TanStack `useQuery` with infinite staleTime so
 * the catalog only fetches once per page load. Errors return 400 with a
 * shape-compatible body so the picker can fall back to "Auto" only.
 */
async function handleApiModels(url: URL, res: ServerResponse): Promise<void> {
  try {
    const force = url.searchParams.get('force') === 'true';
    // Sprint F (Setup gaps): operator can disable a provider in the Setup
    // Providers pane; we hide its models from the picker by default. The
    // Setup screen itself opts in via `?include_disabled=true` so it can
    // render the toggle row even for providers that are currently off.
    const includeDisabled = url.searchParams.get('include_disabled') === 'true';
    const disabled = includeDisabled ? new Set<string>() : getDisabledProviders();

    const catalog = await loadOmnirouteCatalog({ force });
    const providerDisplayById = new Map(
      catalog.providers.map((p) => [p.id, p.displayName] as const),
    );
    const models = catalog.models
      .filter((model) => !disabled.has(model.provider))
      .map((model) => {
        const description = model.use_primary?.trim() || model.use_secondary?.trim() || undefined;
        const recommendedFor = [model.use_primary, model.use_secondary]
          .map((s) => s?.trim())
          .filter((s): s is string => !!s && s.length > 0);
        return {
          id: model.model_id,
          provider: model.provider,
          provider_display: providerDisplayById.get(model.provider) ?? model.provider,
          kind: model.kind,
          source: model.source,
          ...(model.tier ? { tier: model.tier } : {}),
          ...(description ? { description } : {}),
          ...(recommendedFor.length > 0 ? { recommended_for: recommendedFor } : {}),
        };
      });
    const visibleProviders = catalog.providers.filter((p) => !disabled.has(p.id));
    jsonOk(res, {
      models,
      providers: visibleProviders,
      source: catalog.source,
      fetched_at: catalog.fetchedAt,
      total: models.length,
      ...(disabled.size > 0 ? { disabled_providers: [...disabled].sort() } : {}),
      ...(catalog.liveError ? { live_error: catalog.liveError } : {}),
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

export function getDashboardAdvisorModes(db: Database.Database): Partial<Record<string, AdvisorMode>> {
  const row = getDaemonState(db, ADVISOR_MODES_KEY);
  if (!row) return {};
  return normalizeAdvisorModes(row.value);
}

export function setDashboardAdvisorModes(
  db: Database.Database,
  value: unknown,
): Partial<Record<string, AdvisorMode>> {
  const advisorModes = normalizeAdvisorModes(value);
  setDaemonState(db, ADVISOR_MODES_KEY, advisorModes);
  return advisorModes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2.B — auto-tag overrides persistence + runtime cache wire.
// ─────────────────────────────────────────────────────────────────────────────

export function getDashboardAutoTagOverrides(db: Database.Database): AutoTagOverrides {
  const row = getDaemonState(db, AUTO_TAG_OVERRIDES_KEY);
  if (!row) return {};
  return normalizeAutoTagOverrides(row.value);
}

export function setDashboardAutoTagOverrides(
  db: Database.Database,
  value: unknown,
): AutoTagOverrides {
  const overrides = normalizeAutoTagOverrides(value);
  setDaemonState(db, AUTO_TAG_OVERRIDES_KEY, overrides);
  // Push into the in-memory cache so subsequent Omniroute calls see the
  // change without a daemon restart. Empty object means "remove overrides"
  // — fall through to env (or defaults) by clearing the cache.
  setRuntimeAutoTagOverrides(Object.keys(overrides).length > 0 ? overrides : null);
  return overrides;
}

/**
 * Hydrate the in-memory auto-tag overrides cache from daemon_state. Called
 * once at daemon startup so the value persisted by the dashboard survives
 * restarts. Idempotent — safe to call multiple times.
 */
export function hydrateAutoTagOverridesFromDb(db: Database.Database): AutoTagOverrides {
  const overrides = getDashboardAutoTagOverrides(db);
  setRuntimeAutoTagOverrides(Object.keys(overrides).length > 0 ? overrides : null);
  return overrides;
}

function normalizeAdvisorModes(value: unknown): Partial<Record<string, AdvisorMode>> {
  if (!value || typeof value !== 'object') return {};
  const output: Partial<Record<string, AdvisorMode>> = {};
  for (const [advisorName, mode] of Object.entries(value as Record<string, unknown>)) {
    if (ADVISOR_NAME_SET.has(advisorName) && isAdvisorMode(mode)) {
      output[advisorName] = mode;
    }
  }
  return output;
}

function dashboardConfigState(db?: Database.Database): Record<string, unknown> {
  return {
    DECOMPOSER_MODEL: process.env['DECOMPOSER_MODEL'] ?? 'claude/claude-opus-4-6',
    TASK_MODEL: process.env['TASK_MODEL'] ?? 'claude/claude-sonnet-4-6',
    REVIEWER_MODEL: process.env['REVIEWER_MODEL'] ?? 'claude/claude-sonnet-4-6',
    CONSOLIDATOR_MODEL: process.env['CONSOLIDATOR_MODEL'] ?? 'claude/claude-sonnet-4-6',
    OMNIROUTE_TIMEOUT_MS: process.env['OMNIROUTE_TIMEOUT_MS'] ?? '300000',
    OMNIROUTE_MAX_RETRIES: process.env['OMNIROUTE_MAX_RETRIES'] ?? '0',
    OMNIFORGE_MAX_PARALLEL_TASKS: process.env['OMNIFORGE_MAX_PARALLEL_TASKS'] ?? String(getMaxParallelTasks()),
    OMNIFORGE_ADAPTIVE_MAX_ITERATIONS: process.env['OMNIFORGE_ADAPTIVE_MAX_ITERATIONS'] ?? String(getAdaptiveMaxIterations()),
    OMNIFORGE_MAX_PLAN_MODIFICATIONS: process.env['OMNIFORGE_MAX_PLAN_MODIFICATIONS'] ?? String(getMaxPlanModifications()),
    OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR: process.env['OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR'] ?? String(getMaxLlmStreamsPerActor()),
    MAX_REVIEW_TIME_MS: process.env['MAX_REVIEW_TIME_MS'] ?? '120000',
    MAX_CONSOLIDATE_TIME_MS: process.env['MAX_CONSOLIDATE_TIME_MS'] ?? '180000',
    MAX_REFINE_TIME_MS: process.env['MAX_REFINE_TIME_MS'] ?? '120000',
    MAX_REFINE_COST_USD: process.env['MAX_REFINE_COST_USD'] ?? '0.10',
    REFINE_COST_PER_CALL_USD: process.env['REFINE_COST_PER_CALL_USD'] ?? '0.02',
    REVIEW_PASS_THRESHOLD: process.env['REVIEW_PASS_THRESHOLD'] ?? '0.7',
    OMNIFORGE_QUOTA_GUARD: process.env['OMNIFORGE_QUOTA_GUARD'] ?? 'off',
    advisor_modes: db ? getDashboardAdvisorModes(db) : {},
    auto_tag_overrides: db ? getDashboardAutoTagOverrides(db) : {},
  };
}

async function handleDashboardConfig(body: unknown, res: ServerResponse): Promise<void> {
  const db = initDb(getDbPath());
  try {
    const input = body as { key?: string; value?: unknown };
    if (!input?.key || !input.value) {
      jsonOk(res, { current: dashboardConfigState(db), advisor_modes: getDashboardAdvisorModes(db) });
      return;
    }
    if (input.key === ADVISOR_MODES_KEY) {
      const advisorModes = setDashboardAdvisorModes(db, input.value);
      jsonOk(res, {
        updated: { advisor_modes: advisorModes },
        current: dashboardConfigState(db),
        advisor_modes: advisorModes,
      });
      return;
    }
    if (input.key === AUTO_TAG_OVERRIDES_KEY) {
      const overrides = setDashboardAutoTagOverrides(db, input.value);
      jsonOk(res, {
        updated: { auto_tag_overrides: overrides },
        current: dashboardConfigState(db),
        auto_tag_overrides: overrides,
      });
      return;
    }
    const text = await setConfigTool({ key: input.key, value: String(input.value) });
    const result = JSON.parse(text) as Record<string, unknown>;
    jsonOk(res, {
      ...result,
      current: { ...(result['current'] as Record<string, unknown> | undefined), advisor_modes: getDashboardAdvisorModes(db) },
      advisor_modes: getDashboardAdvisorModes(db),
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export const dashboardDataRouter: Router = async (req, url, res, _ctx) => {
  // GETs ----------------------------------------------------------------
  if (req.method === 'GET') {
    if (url.pathname === '/api/dashboard/summary') { handleDashboardSummary(url, res); return true; }
    if (url.pathname === '/api/dashboard/dags') { handleDashboardDagList(url, res); return true; }
    if (url.pathname === '/api/dashboard/models') { await handleDashboardModels(url, res); return true; }
    if (url.pathname === '/api/dashboard/model-catalog') { await handleDashboardModelCatalog(url, res); return true; }
    const runCostMatch = url.pathname.match(/^\/api\/dashboard\/run\/([^/]+)\/cost$/);
    if (runCostMatch) {
      handleDashboardRunCost(decodeURIComponent(runCostMatch[1] ?? ''), res);
      return true;
    }
    // W2 (2026-05-11): parent ↔ remediation-child relationship for the
    // "Awaiting remediation → child" link in RunList. Match both `/run/`
    // and `/runs/` for path-shape consistency with the existing trace
    // endpoint, which uses `/runs/`.
    const remediationMatch = url.pathname.match(
      /^\/api\/dashboard\/runs?\/([^/]+)\/remediation$/,
    );
    if (remediationMatch) {
      handleDashboardRunRemediation(decodeURIComponent(remediationMatch[1] ?? ''), res);
      return true;
    }
    // Sprint F4 (model picker): /api/models is a thin alias of model-catalog
    // tailored to the Composer's ModelPicker (id/provider/tier/description).
    // Catalog source is shared so cache hits cover both endpoints.
    if (url.pathname === '/api/models') { await handleApiModels(url, res); return true; }
    if (url.pathname === '/api/dashboard/config') { await handleDashboardConfig({}, res); return true; }
    if (url.pathname === '/api/dashboard/planner-sessions') { handleDashboardPlannerSessions(url, res); return true; }
    const runTraceMatch = url.pathname.match(/^\/api\/dashboard\/runs\/([^/]+)\/trace$/);
    if (runTraceMatch) {
      handleDashboardRunTrace(decodeURIComponent(runTraceMatch[1] ?? ''), res);
      return true;
    }
  }

  // Mutations -----------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/dashboard/config') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    await handleDashboardConfig(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/workspaces') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardWorkspaceCreate(body, res);
    return true;
  }
  // F4-9: validate-root + open-root MUST come before the generic
  // /workspaces/:name PATCH match below (otherwise "validate-root" gets
  // captured as a workspace name).
  if (req.method === 'POST' && url.pathname === '/api/dashboard/workspaces/validate-root') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardWorkspaceValidateRoot(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/workspaces/open-root') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardWorkspaceOpenRoot(body, res);
    return true;
  }
  const workspaceMatch = url.pathname.match(/^\/api\/dashboard\/workspaces\/([^/]+)$/);
  if (req.method === 'PATCH' && workspaceMatch) {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardWorkspaceUpdate(decodeURIComponent(workspaceMatch[1] ?? ''), body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/planner-sessions') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardPlannerSessionSave(body, res);
    return true;
  }
  const plannerMatch = url.pathname.match(/^\/api\/dashboard\/planner-sessions\/([^/]+)$/);
  if (req.method === 'PATCH' && plannerMatch) {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardPlannerSessionRename(decodeURIComponent(plannerMatch[1] ?? ''), body, res);
    return true;
  }
  if (req.method === 'DELETE' && plannerMatch) {
    handleDashboardPlannerSessionDelete(decodeURIComponent(plannerMatch[1] ?? ''), res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/admin/clear') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardDataClear(body, res);
    return true;
  }

  // ── Sprint F4 (Plan/Build/Discuss) ────────────────────────────────────
  // POST /api/runs/single-task — operator picked Build or Discuss in the
  // Composer; daemon synthesises a one-task workflow (cli_spawn for
  // build, llm_call for discuss) and returns the workflow id so the UI
  // can navigate straight to /runs/<id> without going through preview.
  // Body cap is widened (readLargeJsonBody) because the request can
  // carry up to 5 MB of attachments; per-attachment caps are revalidated
  // by the Zod schema inside runDashboardSingleTask.
  if (req.method === 'POST' && url.pathname === '/api/runs/single-task') {
    let body: unknown;
    try { body = await readLargeJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    try {
      const result = await runDashboardSingleTask(body);
      jsonOk(res, result);
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  return false;
};
