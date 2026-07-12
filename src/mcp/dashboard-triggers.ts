import type Database from 'better-sqlite3';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';

export type DashboardTriggerTargetKind = 'objective' | 'dag';
export type DashboardScheduleRunStatus = 'queued' | 'running' | 'success' | 'error' | 'skipped';
export type DashboardWebhookInvocationStatus = 'accepted' | 'rejected' | 'error';

export interface DashboardSchedule {
  id: string;
  name: string;
  workspace: string;
  target_kind: DashboardTriggerTargetKind;
  target_ref: string;
  input_payload: unknown;
  cron_expression: string;
  timezone: string;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;
  is_active: boolean;
  notify_on: string[];
  notify_email: string | null;
  retry_max: number;
  retry_backoff_seconds: number;
  created_at: number;
  updated_at: number;
}

export interface DashboardScheduleRun {
  id: string;
  schedule_id: string;
  workflow_id: string | null;
  status: DashboardScheduleRunStatus;
  attempt: number;
  scheduled_for: number;
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
  created_at: number;
}

export interface DashboardWebhookTrigger {
  id: string;
  slug: string;
  name: string;
  workspace: string;
  target_kind: DashboardTriggerTargetKind;
  target_ref: string;
  input_payload: unknown;
  secret_fingerprint: string;
  is_active: boolean;
  last_invoked_at: number | null;
  last_status: string | null;
  notify_on: string[];
  notify_email: string | null;
  created_at: number;
  updated_at: number;
}

export interface DashboardWebhookInvocation {
  id: string;
  webhook_id: string | null;
  slug: string;
  workflow_id: string | null;
  signature_valid: boolean;
  status: DashboardWebhookInvocationStatus;
  source_ip: string | null;
  error_message: string | null;
  request_body_preview: string | null;
  created_at: number;
}

interface ScheduleRow {
  id: string;
  name: string;
  workspace: string;
  target_kind: DashboardTriggerTargetKind;
  target_ref: string;
  input_payload_json: string;
  cron_expression: string;
  timezone: string;
  next_run_at: number;
  last_run_at: number | null;
  last_status: string | null;
  is_active: 0 | 1;
  notify_on_json: string;
  notify_email: string | null;
  retry_max: number;
  retry_backoff_seconds: number;
  created_at: number;
  updated_at: number;
}

interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  workflow_id: string | null;
  status: DashboardScheduleRunStatus;
  attempt: number;
  scheduled_for: number;
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
  created_at: number;
}

interface WebhookRow {
  id: string;
  slug: string;
  name: string;
  workspace: string;
  target_kind: DashboardTriggerTargetKind;
  target_ref: string;
  input_payload_json: string;
  signing_secret_hash: string;
  signing_secret_ciphertext: string;
  is_active: 0 | 1;
  last_invoked_at: number | null;
  last_status: string | null;
  notify_on_json: string;
  notify_email: string | null;
  created_at: number;
  updated_at: number;
}

interface WebhookInvocationRow {
  id: string;
  webhook_id: string | null;
  slug: string;
  workflow_id: string | null;
  signature_valid: 0 | 1;
  status: DashboardWebhookInvocationStatus;
  source_ip: string | null;
  error_message: string | null;
  request_body_preview: string | null;
  created_at: number;
}

const MAX_ACTIVE_SCHEDULES = 50;
const MAX_ACTIVE_WEBHOOKS = 50;
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

const notifyOnSchema = z.array(z.enum(['success', 'error', 'cancelled'])).max(3).default([]);

const triggerBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workspace: z.string().trim().min(1).max(64).regex(VALID_WORKSPACE_RE).default('internal'),
  target_kind: z.enum(['objective', 'dag']).default('objective'),
  target_ref: z.string().trim().min(1).max(60_000),
  input_payload: z.unknown().optional().default({}),
  notify_on: notifyOnSchema.optional().default([]),
  notify_email: z.string().trim().email().optional().or(z.literal('')).transform((value) => value || undefined),
});

// M1 / Wave 1-E (A8): minimum interval between schedule fires. The cron
// parser already accepts `* * * * *` (every minute), which can flood the
// daemon with workflows during a misconfiguration. Reject schedules that
// would fire faster than SCHEDULE_MIN_INTERVAL_SECONDS (default 60s = once
// per minute).
//
// Heuristic: if the minute field is bare `*` AND the configured floor is
// >= 60s, refuse. `*/N` for N-minute spacing is allowed at any N. This
// catches the common misconfig without enumerating the entire cron grammar.
const SCHEDULE_MIN_INTERVAL_S = Number(process.env.SCHEDULE_MIN_INTERVAL_SECONDS ?? '60');

const createScheduleSchema = triggerBaseSchema.extend({
  cron_expression: z.string().trim().min(9).max(120).superRefine((expr, ctx) => {
    const fields = expr.split(/\s+/);
    if (fields.length < 5) return; // let assertFiveFieldCron emit the structural error
    const minuteField = fields[0];
    if (minuteField === '*' && SCHEDULE_MIN_INTERVAL_S >= 60) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cron fires every minute, but SCHEDULE_MIN_INTERVAL_SECONDS=${SCHEDULE_MIN_INTERVAL_S}. Use '*/N' for N-minute intervals.`,
      });
    }
  }),
  timezone: z.string().trim().min(1).max(80).default('UTC'),
  is_active: z.boolean().optional().default(true),
  retry_max: z.coerce.number().int().min(0).max(10).default(3),
  retry_backoff_seconds: z.coerce.number().int().min(10).max(86_400).default(60),
});

const createWebhookSchema = triggerBaseSchema.extend({
  slug: z.string().trim().max(80).optional(),
  is_active: z.boolean().optional().default(true),
});

const patchActiveSchema = z.object({
  is_active: z.boolean(),
});

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

function jsonStable(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function toSchedule(row: ScheduleRow): DashboardSchedule {
  return {
    id: row.id,
    name: row.name,
    workspace: row.workspace,
    target_kind: row.target_kind,
    target_ref: row.target_ref,
    input_payload: parseJson(row.input_payload_json),
    cron_expression: row.cron_expression,
    timezone: row.timezone,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    is_active: row.is_active === 1,
    notify_on: parseJsonArray(row.notify_on_json),
    notify_email: row.notify_email,
    retry_max: row.retry_max,
    retry_backoff_seconds: row.retry_backoff_seconds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toScheduleRun(row: ScheduleRunRow): DashboardScheduleRun {
  return { ...row };
}

function toWebhook(row: WebhookRow): DashboardWebhookTrigger {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    workspace: row.workspace,
    target_kind: row.target_kind,
    target_ref: row.target_ref,
    input_payload: parseJson(row.input_payload_json),
    secret_fingerprint: row.signing_secret_hash.slice(0, 12),
    is_active: row.is_active === 1,
    last_invoked_at: row.last_invoked_at,
    last_status: row.last_status,
    notify_on: parseJsonArray(row.notify_on_json),
    notify_email: row.notify_email,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toInvocation(row: WebhookInvocationRow): DashboardWebhookInvocation {
  return {
    ...row,
    signature_valid: row.signature_valid === 1,
  };
}

function activeCount(db: Database.Database, table: 'dashboard_schedules' | 'dashboard_webhook_triggers'): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE is_active = 1`).get() as { count: number };
  return row.count;
}

function normaliseSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug)) {
    throw new Error('slug must be lowercase letters, numbers and hyphens');
  }
  return slug;
}

function uniqueSlug(db: Database.Database, raw: string): string {
  const base = normaliseSlug(raw || `webhook-${randomBytes(3).toString('hex')}`);
  let slug = base;
  for (let i = 0; i < 20; i += 1) {
    const exists = db.prepare(
      `SELECT 1 FROM dashboard_webhook_triggers WHERE slug = ?`,
    ).get(slug) as { 1: number } | undefined;
    if (!exists) return slug;
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  throw new Error('could not allocate unique webhook slug');
}

function cronFieldMatches(value: number, field: string, min: number, max: number): boolean {
  for (const token of field.split(',')) {
    if (token === '*') return true;
    const stepMatch = token.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[1] ?? '', 10);
      if (step > 0 && (value - min) % step === 0) return true;
      continue;
    }
    const rangeMatch = token.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1] ?? '', 10);
      const end = Number.parseInt(rangeMatch[2] ?? '', 10);
      const step = rangeMatch[3] ? Number.parseInt(rangeMatch[3], 10) : 1;
      if (start >= min && end <= max && start <= end && step > 0 && value >= start && value <= end && (value - start) % step === 0) {
        return true;
      }
      continue;
    }
    const numeric = Number.parseInt(token, 10);
    if (String(numeric) === token && numeric >= min && numeric <= max && numeric === value) return true;
  }
  return false;
}

export function assertFiveFieldCron(expression: string): string {
  const expr = expression.trim().replace(/\s+/g, ' ');
  if (expr.startsWith('@')) throw new Error('cron aliases are not supported; use a 5-field expression');
  const parts = expr.split(' ');
  if (parts.length !== 5) throw new Error('cron expression must have exactly 5 fields');
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  parts.forEach((field, index) => {
    if (!field || !field.split(',').every((token) => {
      if (token === '*') return true;
      if (/^\*\/\d+$/.test(token)) return true;
      if (/^\d+$/.test(token)) return true;
      return /^\d+-\d+(?:\/\d+)?$/.test(token);
    })) {
      throw new Error('cron fields may only use numbers, *, */n, ranges and comma lists');
    }
    const [min, max] = ranges[index] ?? [0, 0];
    const checks = field.split(',').flatMap((token) => token.match(/\d+/g) ?? []);
    for (const raw of checks) {
      const value = Number.parseInt(raw, 10);
      if (value < min || value > max) throw new Error(`cron field ${index + 1} contains value outside ${min}-${max}`);
    }
  });
  return expr;
}

export function computeNextRunAt(cronExpression: string, fromMs = Date.now()): number {
  const expr = assertFiveFieldCron(cronExpression);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.split(' ');
  const start = new Date(fromMs);
  start.setUTCSeconds(0, 0);
  const cursor = new Date(start.getTime() + 60_000);
  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (
      cronFieldMatches(cursor.getUTCMinutes(), minute ?? '*', 0, 59)
      && cronFieldMatches(cursor.getUTCHours(), hour ?? '*', 0, 23)
      && cronFieldMatches(cursor.getUTCDate(), dayOfMonth ?? '*', 1, 31)
      && cronFieldMatches(cursor.getUTCMonth() + 1, month ?? '*', 1, 12)
      && cronFieldMatches(cursor.getUTCDay(), dayOfWeek ?? '*', 0, 6)
    ) {
      return cursor.getTime();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error('cron expression did not produce a next run within one year');
}

function secretKey(keyMaterial: string): Buffer {
  return createHash('sha256').update(`omniforge-dashboard-webhooks:${keyMaterial}`).digest();
}

function encryptSecret(secret: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(keyMaterial), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(ciphertext: string, keyMaterial: string): string {
  const [version, ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !encryptedHex) throw new Error('invalid secret ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(keyMaterial), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function hmacSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

export interface DashboardScheduleTickHealth {
  status: string;
  updated_at: number;
  age_ms: number | null;
  processed?: number;
  duration_ms?: number;
  error?: string | null;
}

export function listDashboardTriggers(db: Database.Database): {
  schedules: DashboardSchedule[];
  schedule_runs: DashboardScheduleRun[];
  webhooks: DashboardWebhookTrigger[];
  webhook_invocations: DashboardWebhookInvocation[];
  public_base_url: string;
  last_schedule_tick: DashboardScheduleTickHealth | null;
} {
  const schedules = db.prepare(
    `SELECT * FROM dashboard_schedules ORDER BY is_active DESC, next_run_at ASC, created_at DESC LIMIT 120`,
  ).all() as ScheduleRow[];
  const scheduleRuns = db.prepare(
    `SELECT * FROM dashboard_schedule_runs ORDER BY created_at DESC LIMIT 50`,
  ).all() as ScheduleRunRow[];
  const webhooks = db.prepare(
    `SELECT * FROM dashboard_webhook_triggers ORDER BY is_active DESC, updated_at DESC LIMIT 120`,
  ).all() as WebhookRow[];
  const invocations = db.prepare(
    `SELECT * FROM dashboard_webhook_invocations ORDER BY created_at DESC LIMIT 50`,
  ).all() as WebhookInvocationRow[];

  // Sprint 2.6 (D-H2.066, F-REL-2): surface schedule_tick health to the
  // Studio so operator sees "Last tick HH:MM ✓" / "✗ <error>".
  const tickRow = db
    .prepare("SELECT value_json, updated_at FROM daemon_state WHERE key = 'schedule_tick'")
    .get() as { value_json: string; updated_at: number } | undefined;
  let lastTick: DashboardScheduleTickHealth | null = null;
  if (tickRow) {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(tickRow.value_json) as Record<string, unknown>; }
    catch { parsed = { _parse_error: tickRow.value_json }; }
    lastTick = {
      status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
      updated_at: tickRow.updated_at,
      age_ms: tickRow.updated_at > 0 ? Date.now() - tickRow.updated_at : null,
      processed: typeof parsed.processed === 'number' ? parsed.processed : undefined,
      duration_ms: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : null,
    };
  }

  return {
    schedules: schedules.map(toSchedule),
    schedule_runs: scheduleRuns.map(toScheduleRun),
    webhooks: webhooks.map(toWebhook),
    webhook_invocations: invocations.map(toInvocation),
    public_base_url: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:20129',
    last_schedule_tick: lastTick,
  };
}

export function createDashboardSchedule(db: Database.Database, raw: unknown, now = Date.now()): DashboardSchedule {
  const input = createScheduleSchema.parse(raw);
  if (input.is_active && activeCount(db, 'dashboard_schedules') >= MAX_ACTIVE_SCHEDULES) {
    throw new Error('max 50 active schedules reached');
  }
  const cronExpression = assertFiveFieldCron(input.cron_expression);
  const nextRunAt = computeNextRunAt(cronExpression, now);
  const row: ScheduleRow = {
    id: makeId('sch'),
    name: input.name,
    workspace: input.workspace,
    target_kind: input.target_kind,
    target_ref: input.target_ref,
    input_payload_json: jsonStable(input.input_payload),
    cron_expression: cronExpression,
    timezone: input.timezone,
    next_run_at: nextRunAt,
    last_run_at: null,
    last_status: null,
    is_active: input.is_active ? 1 : 0,
    notify_on_json: JSON.stringify(input.notify_on),
    notify_email: input.notify_email ?? null,
    retry_max: input.retry_max,
    retry_backoff_seconds: input.retry_backoff_seconds,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO dashboard_schedules
       (id, name, workspace, target_kind, target_ref, input_payload_json, cron_expression, timezone,
        next_run_at, last_run_at, last_status, is_active, notify_on_json, notify_email,
        retry_max, retry_backoff_seconds, created_at, updated_at)
     VALUES
       (@id, @name, @workspace, @target_kind, @target_ref, @input_payload_json, @cron_expression, @timezone,
        @next_run_at, @last_run_at, @last_status, @is_active, @notify_on_json, @notify_email,
        @retry_max, @retry_backoff_seconds, @created_at, @updated_at)`,
  ).run(row);
  return toSchedule(row);
}

export function setDashboardScheduleActive(
  db: Database.Database,
  id: string,
  raw: unknown,
  now = Date.now(),
): DashboardSchedule {
  const input = patchActiveSchema.parse(raw);
  const existing = db.prepare(`SELECT * FROM dashboard_schedules WHERE id = ?`).get(id) as ScheduleRow | undefined;
  if (!existing) throw new Error('schedule not found');
  // Only re-check the cap when actually activating a schedule that wasn't
  // already active — re-saving an already-active schedule must not count
  // against the limit twice.
  if (input.is_active && existing.is_active !== 1 && activeCount(db, 'dashboard_schedules') >= MAX_ACTIVE_SCHEDULES) {
    throw new Error('max 50 active schedules reached');
  }
  const nextRunAt = input.is_active ? computeNextRunAt(existing.cron_expression, now) : existing.next_run_at;
  db.prepare(
    `UPDATE dashboard_schedules
        SET is_active = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.is_active ? 1 : 0, nextRunAt, now, id);
  return toSchedule({ ...existing, is_active: input.is_active ? 1 : 0, next_run_at: nextRunAt, updated_at: now });
}

export function dueDashboardSchedules(db: Database.Database, now = Date.now()): DashboardSchedule[] {
  const rows = db.prepare(
    `SELECT * FROM dashboard_schedules
      WHERE is_active = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 25`,
  ).all(now) as ScheduleRow[];
  return rows.map(toSchedule);
}

export function insertDashboardScheduleRun(
  db: Database.Database,
  schedule: Pick<DashboardSchedule, 'id' | 'next_run_at'>,
  now = Date.now(),
): DashboardScheduleRun {
  const row: ScheduleRunRow = {
    id: makeId('sr'),
    schedule_id: schedule.id,
    workflow_id: null,
    status: 'queued',
    attempt: 1,
    scheduled_for: schedule.next_run_at,
    started_at: null,
    completed_at: null,
    error_message: null,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO dashboard_schedule_runs
       (id, schedule_id, workflow_id, status, attempt, scheduled_for, started_at, completed_at, error_message, created_at)
     VALUES
       (@id, @schedule_id, @workflow_id, @status, @attempt, @scheduled_for, @started_at, @completed_at, @error_message, @created_at)`,
  ).run(row);
  return toScheduleRun(row);
}

export function markDashboardScheduleRun(
  db: Database.Database,
  id: string,
  patch: {
    workflow_id?: string | null;
    status: DashboardScheduleRunStatus;
    error_message?: string | null;
    started_at?: number | null;
    completed_at?: number | null;
  },
  now = Date.now(),
): DashboardScheduleRun {
  db.prepare(
    `UPDATE dashboard_schedule_runs
        SET workflow_id = COALESCE(?, workflow_id),
            status = ?,
            error_message = ?,
            started_at = COALESCE(?, started_at),
            completed_at = ?
      WHERE id = ?`,
  ).run(
    patch.workflow_id ?? null,
    patch.status,
    patch.error_message ?? null,
    patch.started_at ?? now,
    patch.completed_at ?? (patch.status === 'running' ? null : now),
    id,
  );
  const row = db.prepare(`SELECT * FROM dashboard_schedule_runs WHERE id = ?`).get(id) as ScheduleRunRow;
  return toScheduleRun(row);
}

export function advanceDashboardSchedule(
  db: Database.Database,
  schedule: Pick<DashboardSchedule, 'id' | 'cron_expression'>,
  status: string,
  now = Date.now(),
): DashboardSchedule {
  const nextRunAt = computeNextRunAt(schedule.cron_expression, now);
  db.prepare(
    `UPDATE dashboard_schedules
        SET next_run_at = ?, last_run_at = ?, last_status = ?, updated_at = ?
      WHERE id = ?`,
  ).run(nextRunAt, now, status, now, schedule.id);
  const row = db.prepare(`SELECT * FROM dashboard_schedules WHERE id = ?`).get(schedule.id) as ScheduleRow;
  return toSchedule(row);
}

export function createDashboardWebhook(
  db: Database.Database,
  raw: unknown,
  keyMaterial: string,
  now = Date.now(),
): { webhook: DashboardWebhookTrigger; signing_secret: string } {
  const input = createWebhookSchema.parse(raw);
  if (input.is_active && activeCount(db, 'dashboard_webhook_triggers') >= MAX_ACTIVE_WEBHOOKS) {
    throw new Error('max 50 active webhooks reached');
  }
  const signingSecret = `whsec_${randomBytes(32).toString('hex')}`;
  const row: WebhookRow = {
    id: makeId('wh'),
    slug: uniqueSlug(db, input.slug ?? input.name),
    name: input.name,
    workspace: input.workspace,
    target_kind: input.target_kind,
    target_ref: input.target_ref,
    input_payload_json: jsonStable(input.input_payload),
    signing_secret_hash: hashSecret(signingSecret),
    signing_secret_ciphertext: encryptSecret(signingSecret, keyMaterial),
    is_active: input.is_active ? 1 : 0,
    last_invoked_at: null,
    last_status: null,
    notify_on_json: JSON.stringify(input.notify_on),
    notify_email: input.notify_email ?? null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO dashboard_webhook_triggers
       (id, slug, name, workspace, target_kind, target_ref, input_payload_json,
        signing_secret_hash, signing_secret_ciphertext, is_active, last_invoked_at, last_status,
        notify_on_json, notify_email, created_at, updated_at)
     VALUES
       (@id, @slug, @name, @workspace, @target_kind, @target_ref, @input_payload_json,
        @signing_secret_hash, @signing_secret_ciphertext, @is_active, @last_invoked_at, @last_status,
        @notify_on_json, @notify_email, @created_at, @updated_at)`,
  ).run(row);
  return { webhook: toWebhook(row), signing_secret: signingSecret };
}

export function setDashboardWebhookActive(
  db: Database.Database,
  id: string,
  raw: unknown,
  now = Date.now(),
): DashboardWebhookTrigger {
  const input = patchActiveSchema.parse(raw);
  const existing = db.prepare(`SELECT * FROM dashboard_webhook_triggers WHERE id = ?`).get(id) as WebhookRow | undefined;
  if (!existing) throw new Error('webhook not found');
  // Same reasoning as setDashboardScheduleActive: only count against the cap
  // when actually flipping an inactive webhook to active.
  if (input.is_active && existing.is_active !== 1 && activeCount(db, 'dashboard_webhook_triggers') >= MAX_ACTIVE_WEBHOOKS) {
    throw new Error('max 50 active webhooks reached');
  }
  db.prepare(
    `UPDATE dashboard_webhook_triggers
        SET is_active = ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.is_active ? 1 : 0, now, id);
  return toWebhook({ ...existing, is_active: input.is_active ? 1 : 0, updated_at: now });
}

export function rotateDashboardWebhookSecret(
  db: Database.Database,
  id: string,
  keyMaterial: string,
  now = Date.now(),
): { webhook: DashboardWebhookTrigger; signing_secret: string } {
  const signingSecret = `whsec_${randomBytes(32).toString('hex')}`;
  const result = db.prepare(
    `UPDATE dashboard_webhook_triggers
        SET signing_secret_hash = ?,
            signing_secret_ciphertext = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(hashSecret(signingSecret), encryptSecret(signingSecret, keyMaterial), now, id);
  if (result.changes === 0) throw new Error('webhook not found');
  const row = db.prepare(`SELECT * FROM dashboard_webhook_triggers WHERE id = ?`).get(id) as WebhookRow;
  return { webhook: toWebhook(row), signing_secret: signingSecret };
}

export function loadDashboardWebhookBySlug(db: Database.Database, slug: string): WebhookRow | null {
  const normalised = normaliseSlug(slug);
  return (db.prepare(
    `SELECT * FROM dashboard_webhook_triggers WHERE slug = ?`,
  ).get(normalised) as WebhookRow | undefined) ?? null;
}

export function verifyDashboardWebhookRequest(input: {
  webhook: WebhookRow;
  keyMaterial: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const timestampMs = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'invalid timestamp' };
  if (Math.abs((input.now ?? Date.now()) - timestampMs) > WEBHOOK_REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'timestamp outside replay window' };
  }
  if (!input.webhook.is_active) return { ok: false, reason: 'webhook disabled' };
  const secret = decryptSecret(input.webhook.signing_secret_ciphertext, input.keyMaterial);
  const expected = hmacSignature(secret, input.timestamp, input.rawBody);
  if (!input.signature.startsWith('sha256=')) return { ok: false, reason: 'invalid signature format' };
  if (!constantTimeEqual(expected, input.signature)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

export function insertDashboardWebhookInvocation(
  db: Database.Database,
  input: {
    webhook_id?: string | null;
    slug: string;
    workflow_id?: string | null;
    signature_valid: boolean;
    status: DashboardWebhookInvocationStatus;
    source_ip?: string | null;
    error_message?: string | null;
    raw_body?: string | null;
  },
  now = Date.now(),
): DashboardWebhookInvocation {
  const row: WebhookInvocationRow = {
    id: makeId('wi'),
    webhook_id: input.webhook_id ?? null,
    slug: input.slug,
    workflow_id: input.workflow_id ?? null,
    signature_valid: input.signature_valid ? 1 : 0,
    status: input.status,
    source_ip: input.source_ip ?? null,
    error_message: input.error_message ?? null,
    request_body_preview: input.raw_body ? input.raw_body.slice(0, 2000) : null,
    created_at: now,
  };
  db.prepare(
    `INSERT INTO dashboard_webhook_invocations
       (id, webhook_id, slug, workflow_id, signature_valid, status, source_ip, error_message, request_body_preview, created_at)
     VALUES
       (@id, @webhook_id, @slug, @workflow_id, @signature_valid, @status, @source_ip, @error_message, @request_body_preview, @created_at)`,
  ).run(row);
  if (input.webhook_id) {
    db.prepare(
      `UPDATE dashboard_webhook_triggers
          SET last_invoked_at = ?, last_status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now, input.status, now, input.webhook_id);
  }
  return toInvocation(row);
}

export function updateDashboardWebhookInvocationWorkflow(
  db: Database.Database,
  id: string,
  workflowId: string | null,
  status: DashboardWebhookInvocationStatus,
  errorMessage?: string | null,
): DashboardWebhookInvocation {
  db.prepare(
    `UPDATE dashboard_webhook_invocations
        SET workflow_id = ?,
            status = ?,
            error_message = ?
      WHERE id = ?`,
  ).run(workflowId, status, errorMessage ?? null, id);
  const row = db.prepare(`SELECT * FROM dashboard_webhook_invocations WHERE id = ?`).get(id) as WebhookInvocationRow;
  return toInvocation(row);
}

export function buildTriggerObjective(targetRef: string, inputPayload: unknown, livePayload?: string): string {
  const parts = [targetRef.trim()];
  const payloadText = jsonStable(inputPayload);
  if (payloadText !== '{}') parts.push(`Configured input payload:\n${payloadText}`);
  if (livePayload?.trim()) parts.push(`Webhook payload:\n${livePayload.trim().slice(0, 20_000)}`);
  return parts.join('\n\n');
}
