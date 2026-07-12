import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';
import {
  normalizeWorkspaceSoftwareTarget,
  validateWorkspaceProfilePatch,
  workspaceProfileFromRow,
  type WorkspaceProfile,
} from '../utils/workspace-profile.js';
import { ensureGitInitialized } from '../utils/git-worktree.js';
import { safeJsonObject } from './_json-utils.js';

const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(VALID_WORKSPACE_RE),
  created_by: z.string().trim().max(64).optional(),
  software_target: z.unknown().optional(),
});

const UpdateWorkspaceSchema = z.object({
  software_target: z.union([z.unknown(), z.null()]).optional(),
});

const ClearDashboardDataSchema = z.object({
  confirm: z.literal('DELETE_DASHBOARD_DATA'),
  include_patterns: z.boolean().optional().default(false),
});

type DeletionCounts = Record<string, number>;

function deleteFrom(db: Database.Database, table: string): number {
  return db.prepare(`DELETE FROM ${table}`).run().changes;
}

export function createDashboardWorkspace(db: Database.Database, raw: unknown): {
  workspace: string;
  created: boolean;
  profile: WorkspaceProfile;
} {
  const input = CreateWorkspaceSchema.parse(raw);
  const metadata: Record<string, unknown> = {};
  if (input.software_target !== undefined) {
    const normalized = normalizeWorkspaceSoftwareTarget(input.software_target);
    metadata['software_target'] = normalized;
    // Camada A: when the operator hands us a project_root, make sure that
    // path exists AND is a git repo before any cli_spawn task hits it.
    // Idempotent — if the dir is already a repo, nothing changes.
    if (normalized && typeof normalized === 'object' && 'project_root' in normalized) {
      const projectRoot = (normalized as { project_root?: unknown }).project_root;
      if (typeof projectRoot === 'string' && projectRoot.length > 0) {
        ensureGitInitialized(projectRoot);
      }
    }
  }
  const result = db.prepare(
    `INSERT OR IGNORE INTO dashboard_workspaces
       (name, created_at, created_by, metadata_json)
     VALUES (?, ?, ?, ?)`,
  ).run(input.name, Date.now(), input.created_by ?? 'dashboard', JSON.stringify(metadata));
  const row = db.prepare(
    `SELECT name AS workspace, metadata_json
       FROM dashboard_workspaces
      WHERE name = ?`,
  ).get(input.name) as { workspace: string; metadata_json: string | null };
  return {
    workspace: input.name,
    created: result.changes > 0,
    profile: workspaceProfileFromRow(row),
  };
}

export function updateDashboardWorkspace(
  db: Database.Database,
  workspace: string,
  raw: unknown,
): WorkspaceProfile {
  if (!VALID_WORKSPACE_RE.test(workspace)) {
    throw new Error(`Invalid workspace name: ${workspace}`);
  }
  UpdateWorkspaceSchema.parse(raw);
  const input = validateWorkspaceProfilePatch(raw);
  const existing = db.prepare(
    `SELECT metadata_json
       FROM dashboard_workspaces
      WHERE name = ?`,
  ).get(workspace) as { metadata_json: string | null } | undefined;
  const metadata: Record<string, unknown> = safeJsonObject(existing?.metadata_json ?? null);

  if (input.software_target !== undefined) {
    if (input.software_target === null) delete metadata['software_target'];
    else metadata['software_target'] = input.software_target;
    if (input.software_target && typeof input.software_target === 'object' && 'project_root' in input.software_target) {
      const projectRoot = (input.software_target as { project_root?: unknown }).project_root;
      if (typeof projectRoot === 'string' && projectRoot.length > 0) {
        ensureGitInitialized(projectRoot);
      }
    }
  }

  db.prepare(
    `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET metadata_json = excluded.metadata_json`,
  ).run(workspace, Date.now(), 'dashboard', JSON.stringify(metadata));

  return workspaceProfileFromRow({
    workspace,
    metadata_json: JSON.stringify(metadata),
  });
}

export function clearDashboardData(db: Database.Database, raw: unknown): {
  ok: true;
  include_patterns: boolean;
  deleted: DeletionCounts;
} {
  const input = ClearDashboardDataSchema.parse(raw);
  const deleted: DeletionCounts = {};

  db.transaction(() => {
    deleted.eval_results = deleteFrom(db, 'eval_results');
    deleted.eval_runs = deleteFrom(db, 'eval_runs');
    deleted.versioned_definition_usages = deleteFrom(db, 'versioned_definition_usages');
    deleted.trace_spans = deleteFrom(db, 'trace_spans');
    deleted.model_calls = deleteFrom(db, 'model_calls');
    deleted.workflow_task_leases = deleteFrom(db, 'workflow_task_leases');
    deleted.reviews = deleteFrom(db, 'reviews');
    deleted.artifacts = deleteFrom(db, 'artifacts');
    deleted.events = deleteFrom(db, 'events');
    deleted.hitl_gates = deleteFrom(db, 'hitl_gates');
    deleted.idempotency_keys = deleteFrom(db, 'idempotency_keys');
    deleted.subagent_message_deliveries = deleteFrom(db, 'subagent_message_deliveries');
    deleted.subagent_messages = deleteFrom(db, 'subagent_messages');
    deleted.subagent_runs = deleteFrom(db, 'subagent_runs');
    deleted.pattern_usage = deleteFrom(db, 'pattern_usage');
    deleted.tasks = deleteFrom(db, 'tasks');
    deleted.workflows = deleteFrom(db, 'workflows');
    deleted.dashboard_webhook_invocations = deleteFrom(db, 'dashboard_webhook_invocations');
    deleted.dashboard_webhook_triggers = deleteFrom(db, 'dashboard_webhook_triggers');
    deleted.dashboard_schedule_runs = deleteFrom(db, 'dashboard_schedule_runs');
    deleted.dashboard_schedules = deleteFrom(db, 'dashboard_schedules');
    deleted.dashboard_planner_sessions = deleteFrom(db, 'dashboard_planner_sessions');
    deleted.dashboard_workspaces = deleteFrom(db, 'dashboard_workspaces');

    if (input.include_patterns) {
      deleted.patterns = deleteFrom(db, 'patterns');
    }
  })();

  return { ok: true, include_patterns: input.include_patterns, deleted };
}

// ─────────────────────────────────────────────────────────────────────────────
// F4-9 (workspace/repo picker hardening): validate a project root before the
// operator submits a Plan/Build/Discuss run. We surface a structured error
// with `code` + `suggested_action` so AskScreen can render an actionable
// toast instead of an opaque "save failed" message.
//
// Checks (in order, fail-fast — first failure wins):
//   1. path is a non-empty string
//   2. path is absolute
//   3. path exists on disk
//   4. path resolves to a directory (not a file or symlink-to-file)
//   5. soft-checks: git repo presence + project markers (warnings only)
//
// "valid" means safe to call `ensureGitInitialized` on — we do NOT auto-init
// here because validation must be side-effect-free (operator might be probing
// a path before deciding to use it).
// ─────────────────────────────────────────────────────────────────────────────

const ValidateProjectRootSchema = z.object({
  project_root: z.string().trim().min(1),
});

export interface ProjectRootStructuredError {
  code: string;
  origin: 'workspace';
  message: string;
  suggested_action: string;
  context: Record<string, unknown>;
}

export interface ProjectRootValidationResult {
  valid: boolean;
  exists: boolean;
  is_directory: boolean;
  is_git_repo: boolean;
  has_package_json: boolean;
  has_project_markers: boolean;
  resolved_path: string;
  errors: ProjectRootStructuredError[];
  warnings: ProjectRootStructuredError[];
}

const PROJECT_MARKER_FILES: ReadonlyArray<string> = [
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '.git',
  'tsconfig.json',
];

function structuredRootError(
  code: string,
  message: string,
  suggested_action: string,
  context: Record<string, unknown>,
): ProjectRootStructuredError {
  return { code, origin: 'workspace', message, suggested_action, context };
}

export function validateProjectRoot(rawInput: unknown): ProjectRootValidationResult {
  const parsed = ValidateProjectRootSchema.safeParse(rawInput);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid project_root';
    return {
      valid: false,
      exists: false,
      is_directory: false,
      is_git_repo: false,
      has_package_json: false,
      has_project_markers: false,
      resolved_path: '',
      errors: [
        structuredRootError(
          'workspace.root_invalid_input',
          message,
          'Provide a non-empty absolute path to your repository or project folder.',
          { input: typeof rawInput === 'object' ? '<object>' : String(rawInput).slice(0, 200) },
        ),
      ],
      warnings: [],
    };
  }

  const rootPath = parsed.data.project_root;

  if (!isAbsolute(rootPath)) {
    return {
      valid: false,
      exists: false,
      is_directory: false,
      is_git_repo: false,
      has_package_json: false,
      has_project_markers: false,
      resolved_path: rootPath,
      errors: [
        structuredRootError(
          'workspace.root_not_absolute',
          `Project root must be an absolute path: ${rootPath}`,
          process.platform === 'win32'
            ? 'Use a full path like C:\\Users\\you\\projects\\my-repo.'
            : 'Use a full path like /Users/you/projects/my-repo.',
          { path: rootPath },
        ),
      ],
      warnings: [],
    };
  }

  const resolved = pathResolve(rootPath);

  if (!existsSync(resolved)) {
    return {
      valid: false,
      exists: false,
      is_directory: false,
      is_git_repo: false,
      has_package_json: false,
      has_project_markers: false,
      resolved_path: resolved,
      errors: [
        structuredRootError(
          'workspace.root_missing',
          `Project root does not exist: ${resolved}`,
          'Create the folder first, or pick another path. Omniforge can auto-init git on a fresh folder, but the folder itself has to exist.',
          { path: resolved },
        ),
      ],
      warnings: [],
    };
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(resolved).isDirectory();
  } catch (err) {
    return {
      valid: false,
      exists: true,
      is_directory: false,
      is_git_repo: false,
      has_package_json: false,
      has_project_markers: false,
      resolved_path: resolved,
      errors: [
        structuredRootError(
          'workspace.root_stat_failed',
          `Could not stat project root: ${err instanceof Error ? err.message : String(err)}`,
          'Check filesystem permissions, then retry.',
          { path: resolved },
        ),
      ],
      warnings: [],
    };
  }

  if (!isDirectory) {
    return {
      valid: false,
      exists: true,
      is_directory: false,
      is_git_repo: false,
      has_package_json: false,
      has_project_markers: false,
      resolved_path: resolved,
      errors: [
        structuredRootError(
          'workspace.root_not_dir',
          `Project root is not a directory: ${resolved}`,
          'Pick the folder that contains your project, not a file inside it.',
          { path: resolved },
        ),
      ],
      warnings: [],
    };
  }

  const isGitRepo = existsSync(join(resolved, '.git'));
  const hasPackageJson = existsSync(join(resolved, 'package.json'));
  const hasMarkers = PROJECT_MARKER_FILES.some((marker) => existsSync(join(resolved, marker)));

  const warnings: ProjectRootStructuredError[] = [];
  if (!isGitRepo) {
    warnings.push(
      structuredRootError(
        'workspace.root_not_git_repo',
        `Folder is not a git repository: ${resolved}`,
        'Omniforge will run "git init" automatically when the first cli_spawn task lands. Confirm this is the right folder before proceeding.',
        { path: resolved },
      ),
    );
  }
  if (!hasMarkers) {
    warnings.push(
      structuredRootError(
        'workspace.root_no_project_markers',
        `No project markers found in ${resolved} (no package.json, Cargo.toml, pyproject.toml, etc.)`,
        'Double-check the path — empty folders or unrelated directories often signal a wrong selection. You can still proceed if this is intentional.',
        { path: resolved },
      ),
    );
  }

  return {
    valid: true,
    exists: true,
    is_directory: true,
    is_git_repo: isGitRepo,
    has_package_json: hasPackageJson,
    has_project_markers: hasMarkers,
    resolved_path: resolved,
    errors: [],
    warnings,
  };
}

// F4-9: open the project root in the OS file browser. Mirrors the workflow
// open-folder pattern (workflow-ops.ts:817) but for an arbitrary user-provided
// path. Validates first so we never spawn explorer on a missing folder.
export function openProjectRoot(rawInput: unknown): {
  ok: true;
  path: string;
  validation: ProjectRootValidationResult;
} {
  const validation = validateProjectRoot(rawInput);
  if (!validation.valid) {
    // Surface the same structured error the validator would have returned.
    const err = new Error(validation.errors[0]?.message ?? 'Invalid project_root') as Error & {
      structured?: ProjectRootStructuredError;
    };
    err.structured = validation.errors[0];
    throw err;
  }

  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const child = spawn(command, [validation.resolved_path], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();

  return { ok: true, path: validation.resolved_path, validation };
}
