/**
 * Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05) — transporte de
 * imagem no chokepoint `callOmnirouteWithUsage`. Ver docs/VISION-SPIKE-2026-07-05.md
 * para a evidência que embasa as decisões: kimi/minimax aceitam content-parts
 * OpenAI (`image_url` com data URI); glm rejeita no endpoint coding; codex-cli
 * é coberto na Wave 2 por path local no prompt; claude-cli e o caminho legado
 * Omniroute ainda falham explicitamente em vez de ignorar a imagem em silêncio.
 *
 * Esta wave cobre só o TRANSPORTE (payload correto saindo no body HTTP); a
 * Wave 2 adiciona o wiring do lado do consumidor (reviewer/etc).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOmnirouteWithUsage } from '../../src/utils/omniroute-call.js';

function buildMinimalPng(): Buffer {
  const SIZE = 4;
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (SIZE * y + x) << 2;
      png.data[idx] = 0;
      png.data[idx + 1] = 255;
      png.data[idx + 2] = 0;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const okResponse = (content = 'ok') =>
  ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content } }],
        model: 'kimi-for-coding',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    responseHeaders: {},
  });

describe('callOmnirouteWithUsage — anexos de imagem (transporte, Fase A Wave 1)', () => {
  const workDir = join(tmpdir(), `aurora-omniroute-images-test-${process.pid}`);
  const envKeys = [
    'KIMI_API_KEY', 'MINIMAX_API_KEY', 'GLM_API_KEY', 'DEEPSEEK_API_KEY',
    'OMNIROUTE_URL', 'OMNIROUTE_API_KEY',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();
  let pngPath: string;

  beforeEach(() => {
    for (const key of envKeys) originalEnv.set(key, process.env[key]);
    process.env.KIMI_API_KEY = 'test-kimi-key';
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.GLM_API_KEY = 'test-glm-key';
    process.env.OMNIROUTE_URL = 'http://omniroute.test';
    process.env.OMNIROUTE_API_KEY = 'test-omniroute-key';
    mkdirSync(workDir, { recursive: true });
    pngPath = join(workDir, 'fixture.png');
    writeFileSync(pngPath, buildMinimalPng());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(workDir, { recursive: true, force: true });
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('(a) images + kimi/ -> body tem content array com part image_url cujo url começa com data:image/', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse('Vermelho.'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await callOmnirouteWithUsage({
      systemPrompt: 'system prompt',
      userPrompt: 'user prompt',
      model: 'kimi/kimi-for-coding',
      images: [{ path: pngPath }],
    });

    expect(result.content).toBe('Vermelho.');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    const parts = body.messages[0].content as Array<Record<string, unknown>>;
    const imagePart = parts.find((p) => p.type === 'image_url');
    expect(imagePart).toBeDefined();
    const imageUrl = (imagePart!.image_url as { url: string }).url;
    expect(imageUrl.startsWith('data:image/')).toBe(true);
    expect(imageUrl).toContain('base64,');
    // A part de texto preserva a concatenação exata system+\n\n+user do caminho string.
    const textPart = parts.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect((textPart!.text as string)).toBe('system prompt\n\nuser prompt');
  });

  it('(b) images + glm/ -> REJEITA citando glm, SEM fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      callOmnirouteWithUsage({
        systemPrompt: 'system',
        userPrompt: 'user',
        model: 'glm/glm-5.2',
        images: [{ path: pngPath }],
      }),
    ).rejects.toThrow(/glm/i);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('(c) sem images + kimi/ -> body inalterado (content string)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse('sem imagem'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await callOmnirouteWithUsage({
      systemPrompt: 'system prompt',
      userPrompt: 'user prompt',
      model: 'kimi/kimi-for-coding',
    });

    expect(result.content).toBe('sem imagem');
    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(typeof body.messages[0].content).toBe('string');
    expect(body.messages[0].content).toBe('system prompt\n\nuser prompt');
  });

  it('(d) images + modelo legado (sem prefixo direct-provider) -> rejeita', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      callOmnirouteWithUsage({
        systemPrompt: 'system',
        userPrompt: 'user',
        model: 'cc/claude-sonnet-4-6',
        images: [{ path: pngPath }],
      }),
    ).rejects.toThrow(/legacy|legado|Omniroute/i);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('images + minimax/ -> também aceita (segundo provider confirmado no spike)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse('Vermelha'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await callOmnirouteWithUsage({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'minimax/MiniMax-M3',
      images: [{ path: pngPath }],
    });

    expect(result.content).toBe('Vermelha');
    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    const parts = body.messages[0].content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('images + claude-cli/ -> rejeita explicitamente porque o spike não confirmou anexo confiável', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      callOmnirouteWithUsage({
        systemPrompt: 'system',
        userPrompt: 'user',
        model: 'claude-cli/opus',
        images: [{ path: pngPath }],
      }),
    ).rejects.toThrow(/cli/i);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('label opcional aparece como part de texto curta antes da imagem', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse('ok'));
    vi.stubGlobal('fetch', mockFetch);

    await callOmnirouteWithUsage({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'kimi/kimi-for-coding',
      images: [{ path: pngPath, label: 'screenshot-before' }],
    });

    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    const parts = body.messages[0].content as Array<Record<string, unknown>>;
    const labelPart = parts.find(
      (p) => p.type === 'text' && (p.text as string).includes('screenshot-before'),
    );
    expect(labelPart).toBeDefined();
  });

  it('múltiplas imagens -> múltiplas image_url parts', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse('ok'));
    vi.stubGlobal('fetch', mockFetch);

    const secondPath = join(workDir, 'fixture2.png');
    writeFileSync(secondPath, buildMinimalPng());

    await callOmnirouteWithUsage({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'kimi/kimi-for-coding',
      images: [{ path: pngPath }, { path: secondPath }],
    });

    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    const parts = body.messages[0].content as Array<Record<string, unknown>>;
    const imageParts = parts.filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(2);
  });
});
