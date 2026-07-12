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

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    // Missing config is expected (workspace without HITL configured).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[HITL] Failed to read ${configPath}: ${(err as Error).message}`);
    }
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return HitlConfigSchema.parse(parsed);
  } catch (err) {
    // Config exists but is malformed/invalid — warn instead of silently
    // falling back to the terminal channel.
    console.warn(`[HITL] Invalid config at ${configPath}, falling back to terminal: ${(err as Error).message}`);
    return null;
  }
}
