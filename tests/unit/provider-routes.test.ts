import { describe, it, expect } from 'vitest';
import {
  resolveDirectProviderRoute,
  stripRoutePrefix,
} from '../../src/utils/provider-routes.js';

describe('resolveDirectProviderRoute', () => {
  it('resolve os 3 provedores diretos', () => {
    expect(resolveDirectProviderRoute('kimi/kimi-for-coding')?.providerName).toBe('kimi');
    expect(resolveDirectProviderRoute('minimax/MiniMax-M3')?.providerName).toBe('minimax');
    expect(resolveDirectProviderRoute('glm/glm-5.2')?.providerName).toBe('glm');
  });

  it('é case-insensitive no prefixo (paridade com isCliModel)', () => {
    expect(resolveDirectProviderRoute('Kimi/kimi-for-coding')?.providerName).toBe('kimi');
    expect(resolveDirectProviderRoute('MiniMax/MiniMax-M3')?.providerName).toBe('minimax');
    expect(resolveDirectProviderRoute('GLM/glm-5.2')?.providerName).toBe('glm');
  });

  it('NÃO colide com model-ids reais do projeto', () => {
    for (const id of ['cc/claude-sonnet-4-6', 'cx/gpt-5.5', 'gemini-cli/gemini-3.1-pro',
                      'kimi-coding/x', 'opencode-go/x', 'claude-cli/', 'codex-cli/gpt-5.5',
                      'constructor/x', 'noslash', '/leading']) {
      expect(resolveDirectProviderRoute(id)).toBeNull();
    }
  });
});

describe('stripRoutePrefix', () => {
  it('remove o prefixo independente de case', () => {
    const route = resolveDirectProviderRoute('Kimi/kimi-for-coding')!;
    expect(stripRoutePrefix('Kimi/kimi-for-coding', route)).toBe('kimi-for-coding');
    expect(stripRoutePrefix('kimi/kimi-for-coding', route)).toBe('kimi-for-coding');
  });

  it('preserva o case do sufixo (model nativo) e não toca em mismatch', () => {
    const minimaxRoute = resolveDirectProviderRoute('minimax/MiniMax-M3')!;
    expect(stripRoutePrefix('minimax/MiniMax-M3', minimaxRoute)).toBe('MiniMax-M3');
    expect(stripRoutePrefix('MiniMax/MiniMax-M3', minimaxRoute)).toBe('MiniMax-M3');
    // Mismatch de provider e model sem barra: retorna intacto.
    expect(stripRoutePrefix('glm/glm-5.2', minimaxRoute)).toBe('glm/glm-5.2');
    expect(stripRoutePrefix('noslash', minimaxRoute)).toBe('noslash');
  });
});
