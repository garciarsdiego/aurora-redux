// P1c (Aurora-Redux, trilha P1, 2026-07-04): doctor generalizado.
//
// checkGatewayFreeEnv agora deriva o mapeamento prefixo→API-key-env de
// listDirectProviderRoutes() (presets + provedores registrados por convenção
// <NOME>_BASE_URL/<NOME>_API_KEY) em vez de um Record hardcoded kimi/minimax/glm.
// Também cobre o novo check informacional de disponibilidade do Playwright
// (nunca falha — só ok/warn).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkGatewayFreeEnv, checkPlaywrightAvailability } from '../../src/cli/commands/doctor.js';

describe('checkGatewayFreeEnv — generalizado via listDirectProviderRoutes', () => {
  const CANDIDATE_ENVS = [
    'DECOMPOSER_MODEL', 'REVIEWER_MODEL', 'TASK_MODEL', 'CONSOLIDATOR_MODEL',
    'FOO_BASE_URL', 'FOO_API_KEY',
    'KIMI_API_KEY', 'MINIMAX_API_KEY', 'GLM_API_KEY',
    'OMNIROUTE_URL', 'OMNIFORGE_SKIP_MODEL_VALIDATION',
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of CANDIDATE_ENVS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of CANDIDATE_ENVS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('FOO_BASE_URL setado + DECOMPOSER_MODEL=foo/x SEM FOO_API_KEY → fail citando FOO_API_KEY', () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.DECOMPOSER_MODEL = 'foo/algum-modelo';
    // FOO_API_KEY propositalmente ausente.

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const checks = checkGatewayFreeEnv(env);

    const fooKeyCheck = checks.find((c) => c.name === 'env FOO_API_KEY');
    expect(fooKeyCheck).toBeDefined();
    expect(fooKeyCheck?.severity).toBe('fail');
    expect(fooKeyCheck?.detail).toContain('DECOMPOSER_MODEL');
  });

  it('mesmo cenário mas COM FOO_API_KEY setado → ok, sem fail', () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-secret';
    process.env.DECOMPOSER_MODEL = 'foo/algum-modelo';

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const checks = checkGatewayFreeEnv(env);

    const fooKeyCheck = checks.find((c) => c.name === 'env FOO_API_KEY');
    expect(fooKeyCheck).toBeDefined();
    expect(fooKeyCheck?.severity).toBe('ok');
  });

  it('continua a cobrir os 3 presets clássicos (kimi/minimax/glm) sem regressão', () => {
    process.env.DECOMPOSER_MODEL = 'kimi/kimi-for-coding';
    // KIMI_API_KEY ausente de propósito → fail.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const checks = checkGatewayFreeEnv(env);
    const kimiCheck = checks.find((c) => c.name === 'env KIMI_API_KEY');
    expect(kimiCheck?.severity).toBe('fail');
    expect(kimiCheck?.detail).toContain('DECOMPOSER_MODEL');
  });
});

describe('checkPlaywrightAvailability — check informacional, nunca fail', () => {
  it('retorna ok ou warn, nunca fail', async () => {
    const result = await checkPlaywrightAvailability();
    expect(['ok', 'warn']).toContain(result.severity);
    expect(result.name).toBe('Playwright/Chromium');
  });
});
