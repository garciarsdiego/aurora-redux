// Adapted from Runfusion/Fusion (MIT) — packages/core/src/global-settings.ts @ 5f6d998
//
// Provides a user-level settings file at ~/.omniforge/settings.json.
// The file is written with mode 0o600 (owner-only read/write) because it
// stores credentials such as daemon_token.
//
// readSettings() NEVER throws — any I/O or parse error returns {}.
// writeSettings() CAN throw — filesystem errors are legitimate failures.
//
// Path override for tests: set OMNIFORGE_SETTINGS_PATH env var to a temp path.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';

function resolveSettingsPath(): string {
  const override = process.env['OMNIFORGE_SETTINGS_PATH'];
  if (override && override.trim().length > 0) return override.trim();
  const settingsDir = join(os.homedir(), '.omniforge');
  return join(settingsDir, 'settings.json');
}

export interface AuroraSettings {
  daemon_token?: string;
}

/**
 * Read settings from ~/.omniforge/settings.json.
 * Returns {} on any error (missing file, parse error, permission denied).
 */
export function readSettings(): AuroraSettings {
  try {
    const filePath = resolveSettingsPath();
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as AuroraSettings;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge patch into ~/.omniforge/settings.json.
 * Creates the directory and file if they do not exist.
 * File is written with mode 0o600 (owner-only read/write).
 */
export function writeSettings(patch: Partial<AuroraSettings>): void {
  const filePath = resolveSettingsPath();
  const existing = readSettings();
  const merged: AuroraSettings = { ...existing, ...patch };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(merged, null, 2), { mode: 0o600, encoding: 'utf-8' });
}
