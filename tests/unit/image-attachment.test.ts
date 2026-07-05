/**
 * Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05) — testes do
 * transporte puro de imagem: `imageToDataUrl` lê um arquivo do disco e monta
 * a data URL `data:<mediaType>;base64,<b64>` consumida pelo chokepoint do
 * omniroute-call quando `input.images` está presente (ver
 * docs/VISION-SPIKE-2026-07-05.md). Nenhum I/O de rede aqui — puro/testável.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import { imageToDataUrl } from '../../src/utils/image-attachment.js';

const SIZE = 8;

/** PNG mínimo determinístico — mesma técnica de canvas-region-check.test.ts. */
function buildMinimalPng(): Buffer {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (SIZE * y + x) << 2;
      png.data[idx] = 255;
      png.data[idx + 1] = 0;
      png.data[idx + 2] = 0;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('imageToDataUrl', () => {
  const workDir = join(tmpdir(), `aurora-image-attachment-test-${process.pid}`);

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lê um .png e retorna dataUrl começando com data:image/png;base64,', () => {
    mkdirSync(workDir, { recursive: true });
    const pngPath = join(workDir, 'fixture.png');
    writeFileSync(pngPath, buildMinimalPng());

    const result = imageToDataUrl(pngPath);

    expect(result.mediaType).toBe('image/png');
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // O base64 do conteúdo real do arquivo deve estar embutido — não um stub.
    const expectedB64 = buildMinimalPng().toString('base64');
    expect(result.dataUrl).toBe(`data:image/png;base64,${expectedB64}`);
  });

  it('infere image/jpeg para extensão .jpg', () => {
    mkdirSync(workDir, { recursive: true });
    const jpgPath = join(workDir, 'fixture.jpg');
    // Conteúdo não precisa ser um JPEG válido para este teste — imageToDataUrl
    // não decodifica a imagem, só lê bytes brutos e infere o mediaType pela
    // extensão do path (contrato do ITEM 1).
    writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const result = imageToDataUrl(jpgPath);

    expect(result.mediaType).toBe('image/jpeg');
    expect(result.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('infere image/jpeg para extensão .jpeg', () => {
    mkdirSync(workDir, { recursive: true });
    const jpegPath = join(workDir, 'fixture.jpeg');
    writeFileSync(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const result = imageToDataUrl(jpegPath);

    expect(result.mediaType).toBe('image/jpeg');
  });

  it('usa image/png como default para extensão desconhecida', () => {
    mkdirSync(workDir, { recursive: true });
    const unknownPath = join(workDir, 'fixture.bin');
    writeFileSync(unknownPath, buildMinimalPng());

    const result = imageToDataUrl(unknownPath);

    expect(result.mediaType).toBe('image/png');
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('é case-insensitive na extensão (.PNG, .JPG)', () => {
    mkdirSync(workDir, { recursive: true });
    const upperPngPath = join(workDir, 'fixture.PNG');
    writeFileSync(upperPngPath, buildMinimalPng());
    expect(imageToDataUrl(upperPngPath).mediaType).toBe('image/png');

    const upperJpgPath = join(workDir, 'fixture.JPG');
    writeFileSync(upperJpgPath, Buffer.from([0xff, 0xd8]));
    expect(imageToDataUrl(upperJpgPath).mediaType).toBe('image/jpeg');
  });

  it('lança erro claro quando o arquivo não existe', () => {
    const missingPath = join(workDir, 'does-not-exist.png');
    expect(() => imageToDataUrl(missingPath)).toThrow();
    try {
      imageToDataUrl(missingPath);
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toMatch(/does-not-exist\.png/);
    }
  });

  it('NUNCA loga o conteúdo do arquivo (nem em caso de erro)', () => {
    const logSpy: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logSpy.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => logSpy.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => logSpy.push(args.map(String).join(' '));
    try {
      mkdirSync(workDir, { recursive: true });
      const pngPath = join(workDir, 'fixture.png');
      writeFileSync(pngPath, buildMinimalPng());
      imageToDataUrl(pngPath);
      const missingPath = join(workDir, 'missing.png');
      try {
        imageToDataUrl(missingPath);
      } catch {
        /* esperado */
      }
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
    const b64Fragment = buildMinimalPng().toString('base64').slice(0, 20);
    for (const line of logSpy) {
      expect(line).not.toContain(b64Fragment);
    }
  });
});
