import { describe, it, expect } from 'vitest';
import {
  resolveDirectProviderRoute,
  stripRoutePrefix,
  extractContentRobust,
  stripThinkBlock,
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

describe('extractContentRobust', () => {
  const wrap = (content?: string, reasoning?: string) => ({
    choices: [{ message: { content, reasoning_content: reasoning } }],
  });

  it('(1) content limpo → trim, sem alterações de corpo', () => {
    expect(extractContentRobust(wrap('  {"ok":true}  '))).toBe('{"ok":true}');
  });

  it('(2) <think> prefixado ao content (MiniMax) → strip, sobra só a resposta', () => {
    const json = wrap('<think>vou decidir isso</think>{"answer":42}');
    expect(extractContentRobust(json)).toBe('{"answer":42}');
  });

  it('(3) <think> SEM fechamento (stream truncado) → null', () => {
    const json = wrap('<think>razão sem fim que nunca fecha o bloco');
    expect(extractContentRobust(json)).toBeNull();
  });

  it('(4) choices vazio → null; message ausente → null', () => {
    expect(extractContentRobust({ choices: [] })).toBeNull();
    expect(extractContentRobust({ choices: [{}] })).toBeNull();
    expect(extractContentRobust({})).toBeNull();
    expect(extractContentRobust(null)).toBeNull();
  });

  it('(5) content vazio após strip (só reasoning) → null', () => {
    const json = wrap('<think>toda a resposta foi reasoning</think>', 'ruído');
    expect(extractContentRobust(json)).toBeNull();
    // content ausente com só reasoning_content também → null
    expect(extractContentRobust(wrap(undefined, 'só reasoning'))).toBeNull();
  });
});

describe('stripThinkBlock', () => {
  it('remove um bloco único e faz trim', () => {
    expect(stripThinkBlock('<think>a</think>resposta')).toBe('resposta');
  });

  it('remove múltiplos blocos <think>', () => {
    const s = '<think>um</think>alpha<think>dois</think>beta';
    expect(stripThinkBlock(s)).toBe('alphabeta');
  });
});
