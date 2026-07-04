import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Artifact, ArtifactKind } from '../types/index.js';
import {
  insertArtifact,
  loadArtifactsByTaskId,
  loadArtifactsByWorkflowId,
} from '../db/persist.js';

const INLINE_THRESHOLD = 16 * 1024; // 16KB

const KIND_EXT: Record<ArtifactKind, string> = {
  json: 'json',
  yaml: 'yaml',
  markdown: 'md',
  text: 'txt',
  binary: 'bin',
};

function inferKind(content: string): ArtifactKind {
  const t = content.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (t.startsWith('---\n') || /^\w[\w-]*:\s/.test(t)) return 'yaml';
  if (t.startsWith('#')) return 'markdown';
  return 'text';
}

export interface SaveArtifactInput {
  workflow_id: string;
  task_id: string | null;
  workspace: string;
  content: string;
  basePath: string;
  kind?: ArtifactKind;
}

export async function saveArtifact(
  db: Database.Database,
  input: SaveArtifactInput,
): Promise<Artifact> {
  const { workflow_id, task_id, workspace, content, basePath } = input;
  const kind = input.kind ?? inferKind(content);
  const contentBytes = Buffer.from(content, 'utf-8');
  const size_bytes = contentBytes.length;
  const hash_sha256 = createHash('sha256').update(contentBytes).digest('hex');
  const id = `ar_${crypto.randomUUID()}`;
  const now = Date.now();

  let content_inline: string | null = null;
  let content_path: string | null = null;

  if (size_bytes < INLINE_THRESHOLD) {
    content_inline = content;
  } else {
    const dir = task_id ? join(basePath, task_id) : join(basePath, '_workflow');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${id}.${KIND_EXT[kind]}`);
    await writeFile(filePath, content, 'utf-8');
    content_path = filePath;
  }

  const artifact: Artifact = {
    id,
    workflow_id,
    task_id,
    workspace,
    kind,
    content_inline,
    content_path,
    size_bytes,
    hash_sha256,
    created_at: now,
  };

  insertArtifact(db, artifact);
  return artifact;
}

export async function loadArtifactContent(artifact: Artifact): Promise<string> {
  if (artifact.content_inline !== null) return artifact.content_inline;
  if (artifact.content_path !== null) return readFile(artifact.content_path, 'utf-8');
  return '';
}

export async function loadArtifactsForTask(
  db: Database.Database,
  taskId: string,
): Promise<Artifact[]> {
  return loadArtifactsByTaskId(db, taskId);
}

export async function loadArtifactsForWorkflow(
  db: Database.Database,
  workflowId: string,
): Promise<Artifact[]> {
  return loadArtifactsByWorkflowId(db, workflowId);
}
