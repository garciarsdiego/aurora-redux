/**
 * MCP tool: omniforge_opencode_sync_models.
 *
 * Wave C / Agent Q (2026-05-09 → 2026-05-10).
 *
 * Forces a fresh `opencode models` discovery and returns the merged result.
 * Aurora's catalog refreshes opportunistically (1h TTL inside opencode-sync,
 * 5min TTL inside the surrounding modelCatalog), so this tool is the explicit
 * escape hatch for operators who just installed/updated opencode and want
 * the new IDs visible right now.
 *
 * Returns a JSON envelope with:
 *   - bin:        which binary was invoked (resolved value, not just default)
 *   - count:      number of opencode entries discovered
 *   - fetched_at: ISO timestamp of the cache stamp (null if discovery failed)
 *   - sample:     up to the first 25 entries (full list omitted to keep MCP
 *                 responses bounded — the operator can `omniforge_list_models`
 *                 once the dashboard reload picks them up).
 *
 * Failure mode: still returns 200, with `count: 0` and an `error_hint` field
 * that mirrors the warning emitted by listOpencodeModels(). Aurora MUST keep
 * working without opencode installed.
 */

import { z } from 'zod';
import {
  getOpencodeModelsFetchedAt,
  refreshOpencodeModels,
  type OpencodeModelEntry,
} from '../../v2/models/opencode-sync.js';

const ENV_BIN = 'OMNIFORGE_OPENCODE_BIN';
const DEFAULT_BIN = 'opencode';
const MAX_SAMPLE = 25;

export const OpencodeSyncModelsSchema = z.object({
  bin_path: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
});

export async function opencodeSyncModelsTool(raw: unknown): Promise<string> {
  const input = OpencodeSyncModelsSchema.parse(raw ?? {});

  const opts: { binPath?: string; timeoutMs?: number } = {};
  if (input.bin_path) opts.binPath = input.bin_path;
  if (typeof input.timeout_ms === 'number') opts.timeoutMs = input.timeout_ms;

  const resolvedBin = input.bin_path ?? process.env[ENV_BIN] ?? DEFAULT_BIN;

  const entries = await refreshOpencodeModels(opts);
  const fetchedAtMs = getOpencodeModelsFetchedAt();

  const sample = entries.slice(0, MAX_SAMPLE).map((e: OpencodeModelEntry) => ({
    id: e.id,
    provider: e.provider,
    model: e.model,
  }));

  const payload: {
    bin: string;
    count: number;
    fetched_at: string | null;
    sample: typeof sample;
    error_hint?: string;
  } = {
    bin: resolvedBin,
    count: entries.length,
    fetched_at: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
    sample,
  };

  if (entries.length === 0) {
    payload.error_hint =
      'opencode binary unavailable, returned non-zero, or printed no parseable entries — Aurora continues without it';
  }

  return JSON.stringify(payload);
}
