import path from 'node:path';

import { z } from 'zod';

import { Vault } from '../../v2/vault/store.js';

const WorkspaceSchema = z.string().min(1);
const VaultPathSchema = z.string().min(1);

export const VaultWriteSchema = z.object({
  workspace: WorkspaceSchema,
  path: VaultPathSchema,
  content: z.string(),
});

export const VaultReadSchema = z.object({
  workspace: WorkspaceSchema,
  path: VaultPathSchema,
});

export const VaultListSchema = z.object({
  workspace: WorkspaceSchema,
  glob: z.string().min(1).optional(),
});

export const VaultDeleteSchema = z.object({
  workspace: WorkspaceSchema,
  path: VaultPathSchema,
});

export const VaultMergeSchema = z.object({
  workspace: WorkspaceSchema,
  path: VaultPathSchema,
  partial: z.record(z.string(), z.unknown()),
});

let vaultInstance: Vault | null = null;

export function getVault(): Vault {
  vaultInstance ??= new Vault(path.resolve('data', 'vault'));
  return vaultInstance;
}

export async function omniforge_vault_write(raw: unknown): Promise<string> {
  const input = VaultWriteSchema.parse(raw);
  const entry = await getVault().write(input.workspace, input.path, input.content);
  return JSON.stringify({ ok: true, entry });
}

export async function omniforge_vault_read(raw: unknown): Promise<string> {
  const input = VaultReadSchema.parse(raw);
  const content = await getVault().read(input.workspace, input.path);
  return JSON.stringify({ workspace: input.workspace, path: input.path, content });
}

export async function omniforge_vault_list(raw: unknown): Promise<string> {
  const input = VaultListSchema.parse(raw);
  const entries = await getVault().list(input.workspace, input.glob);
  return JSON.stringify({ workspace: input.workspace, entries });
}

export async function omniforge_vault_delete(raw: unknown): Promise<string> {
  const input = VaultDeleteSchema.parse(raw);
  await getVault().delete(input.workspace, input.path);
  return JSON.stringify({ ok: true, workspace: input.workspace, path: input.path });
}

export async function omniforge_vault_merge(raw: unknown): Promise<string> {
  const input = VaultMergeSchema.parse(raw);
  const entry = await getVault().deepMerge(input.workspace, input.path, input.partial);
  return JSON.stringify({ ok: true, entry });
}
