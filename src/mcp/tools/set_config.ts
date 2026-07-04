import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDb } from '../../db/client.js';
import { insertEvent } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';

const ALLOWED_KEYS = [
  'DECOMPOSER_MODEL',
  'TASK_MODEL',
  'REVIEWER_MODEL',
  'CONSOLIDATOR_MODEL',
  'OMNIROUTE_TIMEOUT_MS',
  'OMNIROUTE_MAX_RETRIES',
  'OMNIFORGE_MAX_PARALLEL_TASKS',
  'OMNIFORGE_ADAPTIVE_MAX_ITERATIONS',
  'OMNIFORGE_MAX_PLAN_MODIFICATIONS',
  'OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR',
  'MAX_REVIEW_TIME_MS',
  'MAX_CONSOLIDATE_TIME_MS',
  'MAX_REFINE_TIME_MS',
  'MAX_REFINE_COST_USD',
  'REFINE_COST_PER_CALL_USD',
  'REVIEW_PASS_THRESHOLD',
  'OMNIFORGE_QUOTA_GUARD',
] as const;

type ConfigKey = (typeof ALLOWED_KEYS)[number];

const SAFE_CONFIG_VALUE_RE = /^[A-Za-z0-9._:/@+-]+$/;
const NUMERIC_KEYS = new Set<ConfigKey>([
  'OMNIROUTE_TIMEOUT_MS',
  'OMNIROUTE_MAX_RETRIES',
  'OMNIFORGE_MAX_PARALLEL_TASKS',
  'OMNIFORGE_ADAPTIVE_MAX_ITERATIONS',
  'OMNIFORGE_MAX_PLAN_MODIFICATIONS',
  'OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR',
  'MAX_REVIEW_TIME_MS',
  'MAX_CONSOLIDATE_TIME_MS',
  'MAX_REFINE_TIME_MS',
  'MAX_REFINE_COST_USD',
  'REFINE_COST_PER_CALL_USD',
  'REVIEW_PASS_THRESHOLD',
]);

export const SetConfigSchema = z.object({
  key: z.enum(ALLOWED_KEYS),
  value: z.string().min(1).regex(
    SAFE_CONFIG_VALUE_RE,
    'invalid config value: only safe config characters are allowed',
  ),
}).superRefine((input, ctx) => {
  if (NUMERIC_KEYS.has(input.key) && !Number.isFinite(Number(input.value))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `${input.key} must be numeric`,
    });
  }
  if (input.key === 'OMNIFORGE_QUOTA_GUARD' && !['off', 'warn', 'enforce'].includes(input.value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'OMNIFORGE_QUOTA_GUARD must be off, warn or enforce',
    });
  }
});

function updateEnvFile(key: string, value: string): void {
  const envPath = join(process.cwd(), '.env');
  let content = '';
  try { content = readFileSync(envPath, 'utf-8'); } catch { /* file may not exist */ }
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const newLine = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
  writeFileSync(envPath, lines.join('\n'), 'utf-8');
}

function currentState(): Record<ConfigKey, string> {
  return {
    DECOMPOSER_MODEL: process.env['DECOMPOSER_MODEL'] ?? '(default: claude/claude-opus-4-6)',
    TASK_MODEL: process.env['TASK_MODEL'] ?? '(default: claude/claude-sonnet-4-6)',
    REVIEWER_MODEL: process.env['REVIEWER_MODEL'] ?? '(default: claude/claude-sonnet-4-6)',
    CONSOLIDATOR_MODEL: process.env['CONSOLIDATOR_MODEL'] ?? '(default: claude/claude-sonnet-4-6)',
    OMNIROUTE_TIMEOUT_MS: process.env['OMNIROUTE_TIMEOUT_MS'] ?? '(default: 300000 — base floor; per-call timeout scales with prompt size, capped at 1800000 = 30 min)',
    OMNIROUTE_MAX_RETRIES: process.env['OMNIROUTE_MAX_RETRIES'] ?? '(default: 0)',
    OMNIFORGE_MAX_PARALLEL_TASKS: process.env['OMNIFORGE_MAX_PARALLEL_TASKS'] ?? '(default: 0)',
    OMNIFORGE_ADAPTIVE_MAX_ITERATIONS: process.env['OMNIFORGE_ADAPTIVE_MAX_ITERATIONS'] ?? '(default: 10)',
    OMNIFORGE_MAX_PLAN_MODIFICATIONS: process.env['OMNIFORGE_MAX_PLAN_MODIFICATIONS'] ?? '(default: 3)',
    OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR: process.env['OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR'] ?? '(default: 4)',
    MAX_REVIEW_TIME_MS: process.env['MAX_REVIEW_TIME_MS'] ?? '(default: 120000)',
    MAX_CONSOLIDATE_TIME_MS: process.env['MAX_CONSOLIDATE_TIME_MS'] ?? '(default: 180000)',
    MAX_REFINE_TIME_MS: process.env['MAX_REFINE_TIME_MS'] ?? '(default: 120000)',
    MAX_REFINE_COST_USD: process.env['MAX_REFINE_COST_USD'] ?? '(default: 0.10)',
    REFINE_COST_PER_CALL_USD: process.env['REFINE_COST_PER_CALL_USD'] ?? '(default: 0.02)',
    REVIEW_PASS_THRESHOLD: process.env['REVIEW_PASS_THRESHOLD'] ?? '(default: 0.7)',
    OMNIFORGE_QUOTA_GUARD: process.env['OMNIFORGE_QUOTA_GUARD'] ?? '(default: off)',
  };
}

export async function setConfigTool(raw: unknown): Promise<string> {
  const { key, value } = SetConfigSchema.parse(raw);

  // Immediate effect — config.ts reads process.env lazily
  process.env[key] = value;

  // Persist to .env for restart survival
  updateEnvFile(key, value);

  // A5 — audit event so an adversary with MCP access cannot change
  // OMNIFORGE_MAX_PARALLEL_TASKS (or any operational limit) without a
  // recorded trace. We never log the raw value — it's a config key, not a
  // secret, but consistent redaction posture across all config_updated
  // events is easier to audit. workflow_id='_daemon' satisfies the FK via
  // migration 046. Best-effort: any failure must not break the tool call.
  try {
    const db = initDb(getDbPath());
    try {
      insertEvent(db, {
        workflow_id: '_daemon',
        type: 'config_updated',
        payload: {
          key,
          value_set: '<redacted>',
          actor: 'mcp_tool',
        },
      });
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[set_config] audit event failed: ${msg}\n`);
  }

  return JSON.stringify({
    updated: { [key]: value },
    current: currentState(),
    note: 'Efeito imediato nesta sessão. Persistido em .env para próximos restarts.',
  });
}
