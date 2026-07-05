// P3c (Aurora-Redux, trilha P3, 2026-07-05): extensão da MCP tool
// `omniforge_list_models` para incluir uma seção `direct_providers`
// (listAllProviderModels()) ao lado do catálogo legado — sem quebrar o
// contrato de retorno existente (total/shown/models).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/repl/services/modelCatalog.js', () => ({
  loadCatalog: vi.fn(async () => ({
    models: [
      { model_id: 'cc/claude-sonnet-4-6', tier: 'S', use_primary: 'código', use_secondary: '' },
    ],
  })),
}));

vi.mock('../../src/utils/provider-models.js', () => ({
  listAllProviderModels: vi.fn(async () => [
    { provider: 'kimi', models: ['kimi-for-coding'] },
    { provider: 'claude-cli', models: [], note: 'CLI OAuth — modelo da sessão logada' },
  ]),
}));

import { listModelsTool } from '../../src/mcp/tools/list_models.js';

describe('listModelsTool — extensão direct_providers (P3c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserva o contrato legado (total/shown/models)', async () => {
    const text = await listModelsTool({});
    const parsed = JSON.parse(text);
    expect(parsed.total).toBe(1);
    expect(parsed.shown).toBe(1);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].model_id).toBe('cc/claude-sonnet-4-6');
  });

  it('acrescenta a seção direct_providers com o resultado de listAllProviderModels()', async () => {
    const text = await listModelsTool({});
    const parsed = JSON.parse(text);
    expect(parsed.direct_providers).toBeDefined();
    expect(parsed.direct_providers).toEqual([
      { provider: 'kimi', models: ['kimi-for-coding'] },
      { provider: 'claude-cli', models: [], note: 'CLI OAuth — modelo da sessão logada' },
    ]);
  });

  it('filtros existentes (provider/tier/use_case/limit) continuam funcionando sobre o catálogo legado', async () => {
    const text = await listModelsTool({ provider: 'cc' });
    const parsed = JSON.parse(text);
    expect(parsed.total).toBe(1);
    expect(parsed.models[0].model_id).toBe('cc/claude-sonnet-4-6');
  });
});
