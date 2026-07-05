// P3b (Aurora-Redux, trilha P3, 2026-07-05): testes do subcomando
// `omniforge models`. Segue o padrão de doctor.test.ts — exercita as funções
// puras exportadas (formatModelsTable / formatModelsJson / renderModelsReport)
// em vez de invocar o .action() do commander diretamente.

import { describe, it, expect } from 'vitest';
import { formatModelsTable, formatModelsJson } from '../../src/cli/commands/models.js';
import type { ProviderModelsResult } from '../../src/utils/provider-models.js';

const SAMPLE: ProviderModelsResult[] = [
  { provider: 'kimi', models: ['kimi-for-coding', 'kimi-k3'] },
  { provider: 'minimax', error: 'HTTP 500' },
  { provider: 'claude-cli', models: [], note: 'CLI OAuth — modelo da sessão logada' },
];

describe('formatModelsTable', () => {
  it('lista provider → modelos para entradas ok', () => {
    const out = formatModelsTable(SAMPLE);
    expect(out).toContain('kimi');
    expect(out).toContain('kimi-for-coding');
    expect(out).toContain('kimi-k3');
  });

  it('mostra o erro por provider quando presente', () => {
    const out = formatModelsTable(SAMPLE);
    expect(out).toContain('minimax');
    expect(out).toContain('HTTP 500');
  });

  it('mostra a nota informativa para transportes CLI', () => {
    const out = formatModelsTable(SAMPLE);
    expect(out).toContain('claude-cli');
    expect(out).toContain('CLI OAuth');
  });

  it('filtra por --provider quando passado', () => {
    const out = formatModelsTable(SAMPLE, 'kimi');
    expect(out).toContain('kimi-for-coding');
    expect(out).not.toContain('minimax');
    expect(out).not.toContain('claude-cli');
  });

  it('quando nenhum provider tem key nem entradas CLI, mostra mensagem amigável apontando o doctor', () => {
    const out = formatModelsTable([]);
    expect(out.toLowerCase()).toContain('doctor');
  });
});

describe('formatModelsJson', () => {
  it('serializa a lista completa como JSON válido', () => {
    const out = formatModelsJson(SAMPLE);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].provider).toBe('kimi');
  });

  it('filtra por --provider quando passado', () => {
    const out = formatModelsJson(SAMPLE, 'minimax');
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].provider).toBe('minimax');
  });
});
