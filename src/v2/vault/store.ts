import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { insertEvent } from '../../db/persist.js';
import type { VaultEntry, VaultIndex } from './types.js';

/**
 * Optional audit context for vault mutations. When passed, write/delete emit
 * a structured event (vault_write_audited / vault_delete_audited). Content
 * is NEVER logged — only length / path / workspace. Keeping audit OPTIONAL
 * lets MCP tool callers (operator-driven) skip it while
 * workflow-internal callers (automated) get a trace.
 */
export interface VaultAuditContext {
  db: Database.Database;
  workflowId?: string;
  taskId?: string;
}

const FILE_SIZE_CAP = 10 * 1024 * 1024; // 10 MB
const WORKSPACE_SIZE_CAP = 200 * 1024 * 1024; // 200 MB
const INDEX_FILE = '.index.json';

function validatePath(vaultPath: string): void {
  if (path.isAbsolute(vaultPath)) {
    throw new Error(`Path traversal rejected: absolute path not allowed: ${vaultPath}`);
  }
  const normalized = path.normalize(vaultPath);
  if (normalized.startsWith('..') || normalized.includes('..')) {
    throw new Error(`Path traversal rejected: ${vaultPath}`);
  }
}

function detectContentType(vaultPath: string): string {
  const ext = path.extname(vaultPath).toLowerCase();
  const extMap: Record<string, string> = {
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.ts': 'text/typescript',
    '.js': 'text/javascript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
  };
  return extMap[ext] ?? 'text/plain';
}

export class Vault {
  constructor(private readonly rootDir: string) {}

  private workspaceDir(workspace: string): string {
    return path.join(this.rootDir, workspace);
  }

  private filePath(workspace: string, vaultPath: string): string {
    return path.join(this.workspaceDir(workspace), vaultPath);
  }

  private indexPath(workspace: string): string {
    return path.join(this.workspaceDir(workspace), INDEX_FILE);
  }

  private async readIndex(workspace: string): Promise<VaultIndex> {
    const idxPath = this.indexPath(workspace);
    try {
      const raw = await fs.readFile(idxPath, 'utf8');
      return JSON.parse(raw) as VaultIndex;
    } catch {
      return {};
    }
  }

  private async writeIndex(workspace: string, index: VaultIndex): Promise<void> {
    const idxPath = this.indexPath(workspace);
    const tmp = `${idxPath}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
    await fs.rename(tmp, idxPath);
  }

  private totalBytes(index: VaultIndex): number {
    return Object.values(index).reduce((sum, e) => sum + e.sizeBytes, 0);
  }

  async write(
    workspace: string,
    vaultPath: string,
    content: string,
    auditCtx?: VaultAuditContext,
  ): Promise<VaultEntry> {
    validatePath(vaultPath);

    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > FILE_SIZE_CAP) {
      throw new Error(`File exceeds 10 MB cap: ${sizeBytes} bytes`);
    }

    const wsDir = this.workspaceDir(workspace);
    await fs.mkdir(wsDir, { recursive: true });

    const index = await this.readIndex(workspace);
    const currentTotal = this.totalBytes(index);
    const existingSize = index[vaultPath]?.sizeBytes ?? 0;
    const newTotal = currentTotal - existingSize + sizeBytes;

    if (newTotal > WORKSPACE_SIZE_CAP) {
      throw new Error(
        `Workspace size cap (200 MB) would be exceeded: ${newTotal} bytes projected`
      );
    }

    const destPath = this.filePath(workspace, vaultPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    const tmp = `${destPath}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, destPath);

    const now = Date.now();
    const contentType = detectContentType(vaultPath);
    const createdAt = index[vaultPath]?.createdAt ?? now;

    index[vaultPath] = { contentType, createdAt, updatedAt: now, sizeBytes };
    await this.writeIndex(workspace, index);

    // A10 — emit audit event when caller passes context. Content is NEVER
    // logged (it can contain secrets, intermediate model outputs, etc.).
    // workflow_id '_daemon' is the sentinel for tool-level audit when the
    // caller has no enclosing workflow (migration 046).
    if (auditCtx) {
      try {
        insertEvent(auditCtx.db, {
          workflow_id: auditCtx.workflowId ?? '_daemon',
          task_id: auditCtx.taskId ?? null,
          type: 'vault_write_audited',
          payload: { workspace, path: vaultPath, content_length: sizeBytes },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[vault] audit write failed: ${msg}\n`);
      }
    }

    return { path: vaultPath, content, contentType, createdAt, updatedAt: now, sizeBytes };
  }

  async read(workspace: string, vaultPath: string): Promise<string> {
    validatePath(vaultPath);
    const dest = this.filePath(workspace, vaultPath);
    try {
      return await fs.readFile(dest, 'utf8');
    } catch {
      throw new Error(`Vault entry not found: ${workspace}/${vaultPath}`);
    }
  }

  /**
   * B9 pre-validation helper — given a list of vault paths a worker is about
   * to consume, return which ones do NOT exist on disk. Used by worker
   * preHooks to fail fast / emit `vault_input_missing` observability events
   * before the task spawns and reads `(not found)` placeholders.
   *
   * Distinct from `read()` which throws — `checkPaths` is non-throwing and
   * returns a structured result so the caller can decide policy (warn vs.
   * block) without try/catching every entry.
   */
  async checkPaths(
    workspace: string,
    paths: readonly string[],
  ): Promise<{ found: string[]; missing: string[] }> {
    const found: string[] = [];
    const missing: string[] = [];
    for (const vaultPath of paths) {
      try {
        validatePath(vaultPath);
      } catch {
        // Path traversal / absolute → treat as missing for observability;
        // read() would have thrown anyway.
        missing.push(vaultPath);
        continue;
      }
      const dest = this.filePath(workspace, vaultPath);
      try {
        await fs.access(dest);
        found.push(vaultPath);
      } catch {
        missing.push(vaultPath);
      }
    }
    return { found, missing };
  }

  async list(workspace: string, globPattern?: string): Promise<VaultEntry[]> {
    const index = await this.readIndex(workspace);
    const entries: VaultEntry[] = [];

    for (const [p, meta] of Object.entries(index)) {
      if (globPattern && !matchGlob(globPattern, p)) continue;
      let content = '';
      try {
        content = await fs.readFile(this.filePath(workspace, p), 'utf8');
      } catch {
        continue;
      }
      entries.push({ path: p, content, ...meta });
    }

    return entries;
  }

  async delete(
    workspace: string,
    vaultPath: string,
    auditCtx?: VaultAuditContext,
  ): Promise<void> {
    validatePath(vaultPath);
    const dest = this.filePath(workspace, vaultPath);
    try {
      await fs.unlink(dest);
    } catch {
      throw new Error(`Vault entry not found: ${workspace}/${vaultPath}`);
    }
    const index = await this.readIndex(workspace);
    const removedSize = index[vaultPath]?.sizeBytes ?? 0;
    delete index[vaultPath];
    await this.writeIndex(workspace, index);

    // A10 — companion to write() audit. Length captured pre-delete for
    // observability; never the content. See VaultAuditContext doc above.
    if (auditCtx) {
      try {
        insertEvent(auditCtx.db, {
          workflow_id: auditCtx.workflowId ?? '_daemon',
          task_id: auditCtx.taskId ?? null,
          type: 'vault_delete_audited',
          payload: { workspace, path: vaultPath, content_length: removedSize },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[vault] audit delete failed: ${msg}\n`);
      }
    }
  }

  async deepMerge(
    workspace: string,
    vaultPath: string,
    partial: Record<string, unknown>
  ): Promise<VaultEntry> {
    validatePath(vaultPath);

    let existing: Record<string, unknown> = {};
    try {
      const raw = await this.read(workspace, vaultPath);
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // file doesn't exist or isn't JSON — start fresh
    }

    const merged = deepMergeObjects(existing, partial);
    const content = JSON.stringify(merged, null, 2);
    return this.write(workspace, vaultPath, content);
  }
}

function deepMergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMergeObjects(
        target[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

function matchGlob(pattern: string, filePath: string): boolean {
  // Simple glob: supports * (any chars except /) and ** (any chars)
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp(`^${regexStr}$`).test(filePath);
}
