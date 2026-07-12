import type Database from 'better-sqlite3';

import { insertEvent } from './persist.js';
import { safeJsonObject } from './safe-json.js';
import type { CliPermissionMode } from '../executors/cli.js';

function parseMode(value: unknown): CliPermissionMode | undefined {
  return value === 'safe' || value === 'autonomous' ? value : undefined;
}

function modeFromEventPayload(raw: unknown): CliPermissionMode | undefined {
  const payload = safeJsonObject(raw);
  return parseMode(payload['mode']);
}

export function recordWorkflowCliPermissionMode(
  db: Database.Database,
  workflowId: string,
  mode: CliPermissionMode,
  source = 'dashboard',
): void {
  const now = Date.now();
  insertEvent(db, {
    workflow_id: workflowId,
    type: 'workflow_cli_permission_mode',
    payload: { mode, source, updated_at: now },
  });

  const row = db.prepare(`SELECT metadata FROM workflows WHERE id = ?`).get(workflowId) as
    | { metadata: string | null }
    | undefined;
  const metadata = safeJsonObject(row?.metadata);
  metadata['cli_permission_mode'] = mode;
  metadata['cli_permission_source'] = source;
  metadata['cli_permission_updated_at'] = now;
  db.prepare(`UPDATE workflows SET metadata = ? WHERE id = ?`).run(JSON.stringify(metadata), workflowId);
}

export function resolveWorkflowCliPermissionMode(
  db: Database.Database,
  workflowId: string,
): CliPermissionMode | undefined {
  const event = db.prepare(
    `SELECT payload_json
       FROM events
      WHERE workflow_id = ?
        AND type = 'workflow_cli_permission_mode'
      ORDER BY id DESC
      LIMIT 1`,
  ).get(workflowId) as { payload_json: string | null } | undefined;
  const eventMode = modeFromEventPayload(event?.payload_json);
  if (eventMode) return eventMode;

  const workflow = db.prepare(`SELECT metadata FROM workflows WHERE id = ?`).get(workflowId) as
    | { metadata: string | null }
    | undefined;
  const metadata = safeJsonObject(workflow?.metadata);
  return parseMode(metadata['cli_permission_mode']);
}
