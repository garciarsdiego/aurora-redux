import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const AutoApproveIfSchema = z.object({
  kind: z.union([z.string(), z.array(z.string())]).optional(),
  workspace: z.union([z.string(), z.array(z.string())]).optional(),
  model: z.union([z.string(), z.array(z.string())]).optional(),
});

const HitlConfigSchema = z.object({
  channel: z.enum(['terminal', 'slack', 'telegram']).default('terminal'),
  slack_webhook_url: z.string().url().optional(),
  slack_channel: z.string().optional(),
  slack_listener_port: z.number().int().min(1024).max(65535).default(3742),
  slack_listener_public_url: z.string().url().optional(),
  telegram_bot_token: z.string().optional(),
  telegram_chat_id: z.union([z.string(), z.number()]).optional(),
  auto_approve_if: AutoApproveIfSchema.optional(),
});

export type HitlConfig = z.infer<typeof HitlConfigSchema>;

export function loadHitlConfig(workspace: string): HitlConfig | null {
  const configPath = resolve('workspaces', workspace, '.hitl.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return HitlConfigSchema.parse(parsed);
  } catch {
    return null;
  }
}
