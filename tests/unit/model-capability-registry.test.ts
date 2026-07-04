import { describe, it, expect } from 'vitest';
import {
  inferCapabilities,
  parseProviderMatrixCsv,
  rankModels,
  selectModel,
} from '../../src/v2/models/capability-registry.js';

const sampleCsv = [
  'Provedor/Modelo,Uso Primário,Uso Secundário,Score Prim.,Score Sec.,Tier,Eq. Ref.',
  'cc/claude-haiku-4-5-20251001,Tarefa Rápida e Simples,Resposta Imediata,85/100,82/100,B+,70%',
  'cc/claude-opus-4-7,Código Complexo / Planejamento,Análise Arquitetural Profunda,100/100,95/100,S+,100%',
  'gemini-cli/gemini-3.1-pro-preview-customtools,Código Complexo / Planejamento,Análise Arquitetural Profunda,100/100,95/100,S+,100%',
  'ollamacloud/devstral:24b,Resposta Local / Tarefa Prática,Extração de JSON,70/100,65/100,C,50%',
].join('\n');

describe('model capability registry', () => {
  it('parses provider matrix rows into normalized model metadata', () => {
    const catalog = parseProviderMatrixCsv(sampleCsv);
    expect(catalog).toHaveLength(4);
    expect(catalog[0]).toMatchObject({
      model_id: 'cc/claude-haiku-4-5-20251001',
      provider: 'cc',
      score_primary: 85,
      score_secondary: 82,
      tier: 'B+',
      quality_rank: 2,
    });
  });

  it('infers stable capabilities from model/provider naming', () => {
    expect(inferCapabilities('gemini-cli/gemini-3.1-pro-preview-customtools')).toMatchObject({
      streaming: true,
      structured_output: true,
      tool_calling: true,
      multimodal: true,
      local: false,
    });
    expect(inferCapabilities('ollamacloud/devstral:24b')).toMatchObject({
      local: true,
      structured_output: true,
    });
  });

  it('ranks by quality by default while honoring capability filters', () => {
    const catalog = parseProviderMatrixCsv(sampleCsv);
    const ranked = rankModels(catalog, {
      useCase: 'Código Complexo',
      requiredCapabilities: ['tool_calling'],
      strategy: 'quality',
    });
    expect(ranked[0]!.model_id).toBe('gemini-cli/gemini-3.1-pro-preview-customtools');
    expect(ranked.every((m) => m.capabilities.tool_calling)).toBe(true);
  });

  it('can prefer cheaper models for quick tasks', () => {
    const catalog = parseProviderMatrixCsv(sampleCsv);
    const selected = selectModel(catalog, {
      useCase: 'Tarefa Rápida',
      strategy: 'cost',
    });
    expect(selected?.model_id).toBe('cc/claude-haiku-4-5-20251001');
  });

  it('can prefer local/private models when requested', () => {
    const catalog = parseProviderMatrixCsv(sampleCsv);
    const selected = selectModel(catalog, {
      useCase: 'Extração de JSON',
      requiredCapabilities: ['local'],
      strategy: 'quality',
    });
    expect(selected?.model_id).toBe('ollamacloud/devstral:24b');
  });
});
