import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveDirectProviderRoute,
  stripRoutePrefix,
  extractContentRobust,
  stripThinkBlock,
  listDirectProviderRoutes,
  buildDirectProviderUrl,
  getDirectProviderApiKey,
  providerSupportsVision,
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

  // P2a/P2c (Aurora-Redux, trilha P2, 2026-07-05): preset DeepSeek.
  it('resolve o preset deepseek', () => {
    expect(resolveDirectProviderRoute('deepseek/deepseek-chat')?.providerName).toBe('deepseek');
  });

  it('é case-insensitive para o preset deepseek', () => {
    expect(resolveDirectProviderRoute('DeepSeek/deepseek-chat')?.providerName).toBe('deepseek');
    expect(resolveDirectProviderRoute('DEEPSEEK/deepseek-reasoner')?.providerName).toBe('deepseek');
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

  // P2c (Aurora-Redux, trilha P2, 2026-07-05): preserva o sufixo nativo do
  // preset deepseek (deepseek-reasoner), independente do case do prefixo.
  it('preserva o sufixo do preset deepseek', () => {
    const route = resolveDirectProviderRoute('deepseek/deepseek-reasoner')!;
    expect(stripRoutePrefix('deepseek/deepseek-reasoner', route)).toBe('deepseek-reasoner');
    expect(stripRoutePrefix('DeepSeek/deepseek-reasoner', route)).toBe('deepseek-reasoner');
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

// P1a (Aurora-Redux, trilha P1): descoberta dinâmica de provedores diretos
// por convenção `<NOME>_BASE_URL` + `<NOME>_API_KEY`. Cada teste seta/limpa
// suas próprias envs candidatas para não vazar estado entre casos.
describe('descoberta dinâmica de provedores via <NOME>_BASE_URL/<NOME>_API_KEY', () => {
  // Superset de todas as envs que os testes deste describe tocam — limpo
  // antes/depois de cada teste para garantir isolamento independente da
  // estratégia de scan escolhida na implementação (por-chamada ou memoizada).
  const CANDIDATE_ENVS = [
    'FOO_BASE_URL', 'FOO_API_KEY', 'FOO_PATH',
    'BAR_BASE_URL', 'BAR_API_KEY',
    'KIMI_BASE_URL', 'KIMI_API_KEY',
    'OMNIROUTE_BASE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_URL',
    'BAD_NAME_BASE_URL', 'BAD-NAME_API_KEY',
    '1BAD_BASE_URL', '1BAD_API_KEY',
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

  it('registra um provedor novo via FOO_BASE_URL + FOO_API_KEY, prefixo minúsculo', () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-key';
    const route = resolveDirectProviderRoute('foo/some-model');
    expect(route).not.toBeNull();
    expect(route?.providerName).toBe('foo');
    expect(route?.baseUrl).toBe('https://api.foo.example/v1');
    expect(route?.path).toBe('/chat/completions');
    expect(route?.envVar).toBe('FOO_API_KEY');
    expect(route?.baseUrlEnvVar).toBe('FOO_BASE_URL');
  });

  it('é case-insensitive para o provedor dinâmico também', () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-key';
    expect(resolveDirectProviderRoute('Foo/x')?.providerName).toBe('foo');
    expect(resolveDirectProviderRoute('FOO/x')?.providerName).toBe('foo');
  });

  it('honra <NOME>_PATH como override do path default', () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-key';
    process.env.FOO_PATH = '/custom/path';
    expect(resolveDirectProviderRoute('foo/x')?.path).toBe('/custom/path');
  });

  it('registra mesmo com API_KEY ausente (doctor precisa detectar "key faltando")', () => {
    process.env.BAR_BASE_URL = 'https://api.bar.example/v1';
    // BAR_API_KEY ausente de propósito — o registro acontece do mesmo jeito;
    // getDirectProviderApiKey() retornará '' e o caller HTTP falha adiante
    // com a mensagem de key ausente (mesmo contrato dos presets).
    const route = resolveDirectProviderRoute('bar/x');
    expect(route?.providerName).toBe('bar');
    expect(route?.envVar).toBe('BAR_API_KEY');
    expect(getDirectProviderApiKey(route!)).toBe('');
  });

  it('sem BASE_URL não registra mesmo com API_KEY presente', () => {
    process.env.BAR_API_KEY = 'bar-key';
    // BAR_BASE_URL ausente de propósito — nome não vira prefixo reconhecido.
    expect(resolveDirectProviderRoute('bar/x')).toBeNull();
    delete process.env.BAR_API_KEY;
  });

  it('presets têm precedência sobre a descoberta dinâmica', () => {
    process.env.KIMI_BASE_URL = 'https://override.example/v1';
    // KIMI já é preset — não deveria "virar" dinâmico nem duplicar. O preset
    // preserva seu próprio *_BASE_URL override, mas via buildDirectProviderUrl
    // (lido em tempo de uso), não embutido no route.baseUrl estático.
    const route = resolveDirectProviderRoute('kimi/x');
    expect(route?.providerName).toBe('kimi');
    expect(route?.envVar).toBe('KIMI_API_KEY');
    expect(route).not.toBeNull();
    expect(buildDirectProviderUrl(route!)).toBe('https://override.example/v1/chat/completions');
    // Não deve aparecer duas vezes em listDirectProviderRoutes.
    const all = listDirectProviderRoutes();
    expect(all.filter((r) => r.providerName === 'kimi')).toHaveLength(1);
  });

  it('exclui OMNIROUTE_* mesmo se por convenção pareceria um provedor', () => {
    process.env.OMNIROUTE_BASE_URL = 'https://legacy.example/v1';
    process.env.OMNIROUTE_API_KEY = 'legacy-key';
    expect(resolveDirectProviderRoute('omniroute/x')).toBeNull();
    const all = listDirectProviderRoutes();
    expect(all.some((r) => r.providerName === 'omniroute')).toBe(false);
  });

  it('nomes com hífen ou iniciados por dígito não são reconhecidos como NOME válido', () => {
    // 'BAD-NAME_API_KEY' tem hífen — não casa com [A-Z][A-Z0-9_]*, então
    // BAD_NAME_BASE_URL (sem par correspondente exato) não deve registrar.
    process.env['BAD-NAME_API_KEY'] = 'x';
    process.env['1BAD_BASE_URL'] = 'https://x.example/v1';
    process.env['1BAD_API_KEY'] = 'x';
    expect(resolveDirectProviderRoute('1bad/x')).toBeNull();
  });

  it('listDirectProviderRoutes inclui presets + dinâmicos', () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-key';
    const all = listDirectProviderRoutes();
    const names = all.map((r) => r.providerName);
    expect(names).toEqual(expect.arrayContaining(['kimi', 'minimax', 'glm', 'foo']));
  });
});

// P2c (Aurora-Redux, trilha P2, 2026-07-05): preset DeepSeek — URL default e
// leitura da API key. Isola DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL para não vazar
// estado de/para outros testes (mesmo padrão do describe de descoberta acima).
// NÃO faz smoke E2E real contra api.deepseek.com — ver notes da trilha P2 no
// handoff: o smoke 'node scripts/_smoke_transport.mjs deepseek/deepseek-chat'
// fica pendente de uma DEEPSEEK_API_KEY real do operador.
describe('preset deepseek — URL e API key', () => {
  const DEEPSEEK_ENVS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of DEEPSEEK_ENVS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of DEEPSEEK_ENVS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('buildDirectProviderUrl usa a base default quando DEEPSEEK_BASE_URL não está setado', () => {
    const route = resolveDirectProviderRoute('deepseek/deepseek-chat')!;
    expect(buildDirectProviderUrl(route)).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('getDirectProviderApiKey lê DEEPSEEK_API_KEY', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek';
    const route = resolveDirectProviderRoute('deepseek/deepseek-reasoner')!;
    expect(getDirectProviderApiKey(route)).toBe('sk-test-deepseek');
  });

  it('getDirectProviderApiKey retorna string vazia quando a key não está setada', () => {
    const route = resolveDirectProviderRoute('deepseek/deepseek-chat')!;
    expect(getDirectProviderApiKey(route)).toBe('');
  });
});

// Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05): capacidade de
// visão por preset, conforme evidência do spike (docs/VISION-SPIKE-2026-07-05.md)
// — kimi/minimax aceitam content-parts image_url; glm rejeita no endpoint
// coding; deepseek-chat não é modelo de visão, tratado como sem suporte.
describe('providerSupportsVision', () => {
  it('kimi suporta visão', () => {
    const route = resolveDirectProviderRoute('kimi/kimi-for-coding')!;
    expect(providerSupportsVision(route)).toBe(true);
  });

  it('minimax suporta visão', () => {
    const route = resolveDirectProviderRoute('minimax/MiniMax-M3')!;
    expect(providerSupportsVision(route)).toBe(true);
  });

  it('glm NÃO suporta visão (rejeitado pelo endpoint coding no spike)', () => {
    const route = resolveDirectProviderRoute('glm/glm-5.2')!;
    expect(providerSupportsVision(route)).toBe(false);
  });

  it('deepseek NÃO suporta visão (deepseek-chat não é modelo de visão)', () => {
    const route = resolveDirectProviderRoute('deepseek/deepseek-chat')!;
    expect(providerSupportsVision(route)).toBe(false);
  });

  it('rota dinâmica sem o campo vision é tratada como SEM visão (padrão seguro)', () => {
    const saved = { FOO_BASE_URL: process.env.FOO_BASE_URL, FOO_API_KEY: process.env.FOO_API_KEY };
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-key';
    try {
      const route = resolveDirectProviderRoute('foo/some-model')!;
      expect(route.vision).toBeUndefined();
      expect(providerSupportsVision(route)).toBe(false);
    } finally {
      if (saved.FOO_BASE_URL === undefined) delete process.env.FOO_BASE_URL;
      else process.env.FOO_BASE_URL = saved.FOO_BASE_URL;
      if (saved.FOO_API_KEY === undefined) delete process.env.FOO_API_KEY;
      else process.env.FOO_API_KEY = saved.FOO_API_KEY;
    }
  });
});
