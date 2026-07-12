import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as pathResolve } from 'node:path';
import { z } from 'zod';
import { initDb } from '../db/client.js';
import { getDbPath } from './config.js';
import { safeJsonObject } from './safe-parse-json.js';
import { isPathInsideRoot } from './workspace.js';

const WorkspaceSoftwareTargetInputSchema = z.object({
  project_root: z.string().trim().min(1).max(4096),
  cwd: z.string().trim().min(1).max(4096).optional(),
  base_ref: z.union([z.string().trim().min(1).max(256), z.null()]).optional(),
});

const WorkspaceProfilePatchSchema = z.object({
  software_target: z.union([WorkspaceSoftwareTargetInputSchema, z.null()]).optional(),
});

export interface WorkspaceSoftwareTarget {
  project_root: string;
  cwd: string;
  base_ref: string | null;
}

export interface WorkspaceProfile {
  workspace: string;
  software_target: WorkspaceSoftwareTarget | null;
}

function assertExistingDirectory(targetPath: string, label: string): void {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} does not exist: ${targetPath}`);
  }
  if (!statSync(targetPath).isDirectory()) {
    throw new Error(`${label} must be a directory: ${targetPath}`);
  }
}

export function normalizeWorkspaceSoftwareTarget(raw: unknown): WorkspaceSoftwareTarget {
  const parsed = WorkspaceSoftwareTargetInputSchema.parse(raw);
  if (!isAbsolute(parsed.project_root)) {
    throw new Error(`software_target.project_root must be absolute: ${parsed.project_root}`);
  }

  const projectRoot = pathResolve(parsed.project_root);
  assertExistingDirectory(projectRoot, 'software_target.project_root');

  const cwd = parsed.cwd
    ? (isAbsolute(parsed.cwd)
      ? pathResolve(parsed.cwd)
      : pathResolve(projectRoot, parsed.cwd))
    : projectRoot;
  if (!isPathInsideRoot(cwd, projectRoot)) {
    throw new Error(`software_target.cwd must stay inside project_root: ${cwd}`);
  }
  assertExistingDirectory(cwd, 'software_target.cwd');

  return {
    project_root: projectRoot,
    cwd,
    base_ref: parsed.base_ref ?? null,
  };
}

export function validateWorkspaceProfilePatch(raw: unknown): {
  software_target?: WorkspaceSoftwareTarget | null;
} {
  const parsed = WorkspaceProfilePatchSchema.parse(raw);
  return {
    software_target:
      parsed.software_target === undefined
        ? undefined
        : parsed.software_target === null
          ? null
          : normalizeWorkspaceSoftwareTarget(parsed.software_target),
  };
}

export function workspaceProfileFromRow(row: {
  workspace: string;
  metadata_json: string | null;
}): WorkspaceProfile {
  const metadata = safeJsonObject(row.metadata_json, { where: 'workspace_profile.metadata_json' });
  try {
    return {
      workspace: row.workspace,
      software_target:
        metadata['software_target'] === undefined || metadata['software_target'] === null
          ? null
          : normalizeWorkspaceSoftwareTarget(metadata['software_target']),
    };
  } catch {
    return {
      workspace: row.workspace,
      software_target: null,
    };
  }
}

export function loadWorkspaceProfile(workspace: string): WorkspaceProfile | null {
  const db = initDb(getDbPath());
  try {
    const row = db.prepare(
      `SELECT name AS workspace, metadata_json
         FROM dashboard_workspaces
        WHERE name = ?`,
    ).get(workspace) as { workspace: string; metadata_json: string | null } | undefined;
    if (!row) return null;
    return workspaceProfileFromRow(row);
  } catch {
    return null;
  } finally {
    db.close();
  }
}
