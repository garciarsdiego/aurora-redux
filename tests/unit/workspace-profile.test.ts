import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceSoftwareTarget,
  validateWorkspaceProfilePatch,
  workspaceProfileFromRow,
} from '../../src/utils/workspace-profile.js';

describe('workspace software target profiles', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('normalizes relative cwd paths inside the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniforge-workspace-profile-'));
    tempDirs.push(root);
    const projectRoot = join(root, 'project');
    const cwd = join(projectRoot, 'packages', 'worker');
    await mkdir(cwd, { recursive: true });

    const target = normalizeWorkspaceSoftwareTarget({
      project_root: projectRoot,
      cwd: 'packages/worker',
      base_ref: 'main',
    });

    expect(target).toEqual({
      project_root: resolve(projectRoot),
      cwd: resolve(cwd),
      base_ref: 'main',
    });
  });

  it('rejects cwd paths that escape the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniforge-workspace-profile-'));
    tempDirs.push(root);
    const projectRoot = join(root, 'project');
    await mkdir(projectRoot, { recursive: true });

    expect(() => normalizeWorkspaceSoftwareTarget({
      project_root: projectRoot,
      cwd: '../outside',
    })).toThrow(/must stay inside project_root/);
  });

  it('parses patch payloads and rows into stable workspace profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniforge-workspace-profile-'));
    tempDirs.push(root);
    const projectRoot = join(root, 'repo');
    await mkdir(projectRoot, { recursive: true });

    const patch = validateWorkspaceProfilePatch({
      software_target: {
        project_root: projectRoot,
      },
    });
    expect(patch.software_target).toEqual({
      project_root: resolve(projectRoot),
      cwd: resolve(projectRoot),
      base_ref: null,
    });

    const profile = workspaceProfileFromRow({
      workspace: 'internal',
      metadata_json: JSON.stringify({
        software_target: {
          project_root: projectRoot,
          cwd: projectRoot,
          base_ref: 'develop',
        },
      }),
    });
    expect(profile).toEqual({
      workspace: 'internal',
      software_target: {
        project_root: resolve(projectRoot),
        cwd: resolve(projectRoot),
        base_ref: 'develop',
      },
    });
  });
});
