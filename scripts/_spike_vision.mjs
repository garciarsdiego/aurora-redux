// Vision-support spike (Aurora-Redux, trilha S6, 2026-07-05).
//
// Objetivo: descobrir empiricamente quais transportes atuais aceitam imagem
// e COMO, para decidir a viabilidade da Fase A do visual reviewer.
//
//   - kimi/ minimax/ glm/  -> HTTP direto (provider-routes.ts). Testamos com
//     content parts estilo OpenAI (`image_url` com data URI base64).
//   - claude-cli/          -> `claude --print` via stdin. Testamos se a CLI
//     resolve um PATH absoluto mencionado no prompt (não há upload de imagem
//     via texto puro — isso é o ponto do spike).
//   - codex-cli/           -> `codex exec --ignore-user-config` via stdin.
//     Mesma pergunta: o texto do prompt referenciando o PATH é suficiente
//     para a CLI "ver" a imagem, ou ela apenas alucina/recusa?
//
// Sem dependências novas: o PNG é construído byte-a-byte (chunks IHDR/IDAT/
// IEND com CRC32 calculado manualmente) e comprimido com o zlib nativo do
// Node. Custo: 1 chamada mínima por transporte HTTP + 1 invocação por CLI —
// autorizado pelo escopo da trilha S6.
//
// Uso: node scripts/_spike_vision.mjs
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// Import directly from src/ via tsx (already a project devDependency) so the
// spike always exercises the CURRENT source, regardless of whether another
// concurrent track has rebuilt dist/. Run this file with `npx tsx` (see
// verification command in docs/VISION-SPIKE-2026-07-05.md), not plain `node`.
import {
  resolveDirectProviderRoute,
  buildDirectProviderUrl,
  getDirectProviderApiKey,
  extractContentRobust,
} from '../src/utils/provider-routes.ts';
// Reuse the SAME binary-resolution + spawn-shaping helpers the real engine
// uses for these CLIs (cli-invoker.ts) instead of a naive spawnSync('codex',
// ...), which ENOENTs on Windows because `codex` has no extension and
// child_process without shell:true won't resolve PATHEXT (.cmd/.exe) itself.
import { claudeBin, codexBin } from '../src/executors/cli/bin-resolver.ts';
import { resolveSpawnTarget, buildCliSpawnOptions } from '../src/executors/cli/spawn-common.ts';

// ---------------------------------------------------------------------------
// 1. PNG determinístico: 64x64, metade superior vermelha pura, metade
//    inferior azul pura. Construído programaticamente (sem canvas/deps).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Build a 64x64 8-bit RGB PNG, two solid-color halves.
 * invert=false: top half pure red (255,0,0), bottom half pure blue (0,0,255).
 * invert=true:  top half pure blue, bottom half pure red — used as a control
 *   image for the CLI transports (claude-cli/codex-cli) so a "correct"
 *   answer can be checked against a SECOND image where the correct answer
 *   flips. If a CLI answers the same color both times, that's alucination/
 *   coincidence, not real image reading. Not used for the HTTP transports —
 *   those already produce structured yes/no evidence (HTTP status + content
 *   shape) without needing this control, so the spike stays at 1 call each.
 */
function buildRedBluePng(invert = false) {
  const WIDTH = 64;
  const HEIGHT = 64;
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(WIDTH, 0);
  ihdrData.writeUInt32BE(HEIGHT, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: 2 = truecolor (RGB)
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = chunk('IHDR', ihdrData);

  // Raw scanlines: each row prefixed with filter-type byte 0 (none).
  const rowBytes = 1 + WIDTH * 3;
  const raw = Buffer.alloc(rowBytes * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    const topIsRed = y < HEIGHT / 2 ? !invert : invert;
    for (let x = 0; x < WIDTH; x++) {
      const px = rowStart + 1 + x * 3;
      if (topIsRed) {
        raw[px] = 255; raw[px + 1] = 0; raw[px + 2] = 0; // pure red
      } else {
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 255; // pure blue
      }
    }
  }

  const idat = chunk('IDAT', deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_SIGNATURE, ihdr, idat, iend]);
}

const pngBuffer = buildRedBluePng(false); // top=red, bottom=blue
const pngPath = join(os.tmpdir(), 'aurora-vision-spike-64x64.png');
writeFileSync(pngPath, pngBuffer);
const pngBase64 = pngBuffer.toString('base64');
const dataUri = `data:image/png;base64,${pngBase64}`;

// Control image for the CLI transports: same construction, colors swapped
// (top=blue, bottom=red). See buildRedBluePng() doc comment above.
const pngBufferInverted = buildRedBluePng(true);
const pngPathInverted = join(os.tmpdir(), 'aurora-vision-spike-64x64-inverted.png');
writeFileSync(pngPathInverted, pngBufferInverted);

console.log(`[setup] PNG written to ${pngPath} (${pngBuffer.length} bytes, base64 len=${pngBase64.length})`);
console.log(`[setup] Control (inverted) PNG written to ${pngPathInverted}`);

const QUESTION = 'Qual a cor da metade superior da imagem? Responda uma palavra.';

// ---------------------------------------------------------------------------
// 2. HTTP direto: kimi / minimax / glm
// ---------------------------------------------------------------------------

const results = [];

async function testHttpProvider(providerName) {
  const route = resolveDirectProviderRoute(`${providerName}/x`);
  if (!route) {
    results.push({
      transport: providerName,
      hasImage: 'n/a',
      mechanism: 'n/a',
      evidence: 'resolveDirectProviderRoute retornou null — rota desconhecida.',
      recommendation: 'Investigar provider-routes.ts antes da Fase A.',
    });
    return;
  }
  const apiKey = getDirectProviderApiKey(route);
  if (!apiKey) {
    results.push({
      transport: providerName,
      hasImage: 'não testado',
      mechanism: 'n/a',
      evidence: `Env var ${route.envVar} ausente/vazia no .env — spike pulado.`,
      recommendation: 'Sem key, sem dado empírico. Rodar spike novamente quando a key existir.',
    });
    return;
  }

  const url = buildDirectProviderUrl(route);
  // Model id nativo mínimo por provider — mesmo usado no smoke de transporte
  // 2026-07-04 (ver provider-routes.ts comentário de topo).
  const NATIVE_MODEL = {
    kimi: 'kimi-for-coding',
    minimax: 'MiniMax-M3',
    glm: 'glm-5.2',
  }[providerName];

  const body = {
    model: NATIVE_MODEL,
    // Deliberately no `temperature` override: kimi's native model rejects
    // temperature=0 ("only 1 is allowed for this model") and the spike's
    // goal is to test IMAGE support, not temperature semantics per provider.
    // max_tokens generoso (não 20): a 1a rodada do spike mostrou kimi/minimax
    // devolvendo content="" com reasoning_content ainda "pensando" a
    // pergunta — o budget de 20 tokens cortou a resposta ANTES de qualquer
    // veredito sobre a imagem, o que teria sido lido erroneamente como
    // "não suporta imagem" quando na verdade era só budget insuficiente.
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: QUESTION },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  };

  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const text = await res.text();
    if (!res.ok) {
      results.push({
        transport: providerName,
        hasImage: 'provável não (ou formato incorreto)',
        mechanism: 'content-part base64 (testado) — rejeitado pelo servidor',
        evidence: `HTTP ${res.status} em ${dt}s: ${text.slice(0, 200)}`,
        recommendation: 'Checar payload/doc do provider para o formato de image_url correto antes de assumir não-suporte.',
      });
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      results.push({
        transport: providerName,
        hasImage: 'indeterminado',
        mechanism: 'content-part base64 (testado)',
        evidence: `HTTP ${res.status} mas corpo não é JSON: ${text.slice(0, 200)}`,
        recommendation: 'Investigar resposta bruta antes da Fase A.',
      });
      return;
    }
    const content = extractContentRobust(json);
    const answeredRed = typeof content === 'string' && /vermelh|red/i.test(content);
    // extractContentRobust returns null when message.content is empty even
    // though the raw response has usable data (e.g. reasoning ate the whole
    // budget, or the provider replied ONLY in reasoning_content). Dump the
    // raw message shape too so the .md doc can show real evidence instead of
    // a bare "null".
    const rawMessage = json?.choices?.[0]?.message ?? null;
    const evidenceContent = content !== null
      ? JSON.stringify(content).slice(0, 150)
      : `null (raw message=${JSON.stringify(rawMessage).slice(0, 200)})`;
    results.push({
      transport: providerName,
      hasImage: answeredRed ? 'SIM' : 'incerto (respondeu, mas não identificou a cor certa)',
      mechanism: 'content-part base64 (OpenAI-style image_url data URI)',
      evidence: `HTTP ${res.status} em ${dt}s | content=${evidenceContent}`,
      recommendation: answeredRed
        ? 'Viável para Fase A: reusar o mesmo path HTTP com content-parts.'
        : 'Suporte HTTP existe mas resposta não confirma leitura da imagem — validar com mais amostras antes de confiar na Fase A.',
    });
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({
      transport: providerName,
      hasImage: 'erro de transporte',
      mechanism: 'content-part base64 (tentado)',
      evidence: `Exceção em ${dt}s: ${String(e.message).slice(0, 200)}`,
      recommendation: 'Investigar erro de rede/SDK antes de decidir viabilidade.',
    });
  }
}

// ---------------------------------------------------------------------------
// 3 & 4. CLIs locais: claude-cli, codex-cli
// ---------------------------------------------------------------------------

// Regex de recusa/sem-acesso é verificado ANTES do regex de "resposta certa"
// — uma recusa pode mencionar a palavra "vermelho" incidentalmente (ex.:
// citando o prompt de volta, ou listando "vermelho ou azul" como opções) sem
// de fato ter lido o arquivo. Ordem importa. (Bug encontrado na 1a rodada do
// spike: uma recusa completa foi classificada como "resposta correta".)
const NO_ACCESS_RE = /não (consigo|posso|tenho acesso|é possível)|nao (consigo|posso|tenho acesso)|preciso da sua aprovação|bloquead[ao]|cannot access|no access|unable to (open|read|access)|permission denied|access denied|fora do diretório|fora do diret[oó]rio/i;
const ANSWERED_RED_RE = /\b(vermelha?|red)\b/i;

/** Run one CLI invocation against one image path. Returns a raw outcome object (no `results` push). */
function invokeCliOnce(binResolver, extraArgs, timeoutMs, imagePath) {
  const prompt = `O arquivo de imagem está neste caminho absoluto: ${imagePath}\n` +
    `Abra/leia esse arquivo PNG e responda: ${QUESTION}`;
  const t0 = Date.now();
  const bin = binResolver();
  const target = resolveSpawnTarget(bin, extraArgs);
  const base = buildCliSpawnOptions();
  const proc = spawnSync(target.executable, target.finalArgs, {
    ...base,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
    windowsHide: true,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  return { proc, dt, resolvedBin: target.executable };
}

/**
 * Test a CLI transport TWICE — once against the normal image (top=red) and
 * once against the control/inverted image (top=blue) — so a "correct" answer
 * can be checked against a flipped ground truth. This is the only way to
 * distinguish "CLI actually read the file" from "CLI guessed/hallucinated a
 * plausible color" when there is no known upload mechanism (2 outcomes, 50%
 * baseline chance of a single lucky match).
 */
function testCli(name, binResolver, extraArgs, timeoutMs) {
  let normalOutcome;
  let invertedOutcome;
  try {
    normalOutcome = invokeCliOnce(binResolver, extraArgs, timeoutMs, pngPath);
  } catch (e) {
    results.push({
      transport: name,
      hasImage: 'erro',
      mechanism: 'path mencionado no prompt (tentado)',
      evidence: `Exceção na chamada normal: ${String(e.message).slice(0, 200)}`,
      recommendation: 'Investigar antes da Fase A.',
    });
    return;
  }

  const { proc: procN, dt: dtN, resolvedBin } = normalOutcome;
  if (procN.error) {
    results.push({
      transport: name,
      hasImage: 'erro de spawn',
      mechanism: 'path mencionado no prompt (testado)',
      evidence: `Spawn falhou em ${dtN}s (bin resolvido=${resolvedBin}): ${String(procN.error.message).slice(0, 200)}`,
      recommendation: `Verificar resolução de binário (bin-resolver.ts) para ${name} antes de repetir o spike.`,
    });
    return;
  }
  const stdoutN = (procN.stdout || '').trim();
  const stderrN = (procN.stderr || '').trim();
  if (procN.status !== 0) {
    results.push({
      transport: name,
      hasImage: 'erro (exit != 0)',
      mechanism: 'path mencionado no prompt (testado)',
      evidence: `exit=${procN.status} em ${dtN}s | stdout=${stdoutN.slice(0, 150)} | stderr=${stderrN.slice(0, 200)}`,
      recommendation: 'CLI falhou antes de responder — investigar flags/ambiente antes da Fase A.',
    });
    return;
  }

  const admitsNoAccessN = NO_ACCESS_RE.test(stdoutN);
  if (admitsNoAccessN) {
    // No need to burn the second (control) call — the CLI already told us
    // plainly it can't read the file. Clear-cut negative.
    results.push({
      transport: name,
      hasImage: 'NÃO — CLI admite não ter acesso ao arquivo',
      mechanism: 'texto do prompt referenciando PATH absoluto (NÃO upload real de imagem)',
      evidence: `exit=0 em ${dtN}s | stdout=${JSON.stringify(stdoutN).slice(0, 400)}`,
      recommendation: 'CLI recusa/bloqueia leitura de arquivo fora do diretório de trabalho da sessão — Fase A via este transporte NÃO é viável sem allowlist/approval explícito.',
    });
    return;
  }

  const answeredRedN = ANSWERED_RED_RE.test(stdoutN);
  const answeredBlueN = /\bazul|blue\b/i.test(stdoutN);
  if (!answeredRedN && !answeredBlueN) {
    results.push({
      transport: name,
      hasImage: 'NÃO — resposta não corresponde a nenhuma cor esperada (provável recusa/alucinação atípica)',
      mechanism: 'texto do prompt referenciando PATH absoluto (NÃO upload real de imagem)',
      evidence: `exit=0 em ${dtN}s | stdout=${JSON.stringify(stdoutN).slice(0, 400)}`,
      recommendation: 'CLI não lê o arquivo a partir do path mencionado em texto — Fase A via este transporte precisaria de um mecanismo de anexo real (se existir) ou não é viável.',
    });
    return;
  }

  // Answered a plausible color on the normal image — run the CONTROL
  // (inverted) image to see if the answer flips accordingly.
  try {
    invertedOutcome = invokeCliOnce(binResolver, extraArgs, timeoutMs, pngPathInverted);
  } catch (e) {
    results.push({
      transport: name,
      hasImage: `respondeu "${answeredRedN ? 'vermelha' : 'azul'}" na imagem normal, mas o controle invertido falhou`,
      mechanism: 'texto do prompt referenciando PATH absoluto (NÃO upload real de imagem)',
      evidence: `normal: exit=0 em ${dtN}s stdout=${JSON.stringify(stdoutN).slice(0, 200)} | controle: exceção ${String(e.message).slice(0, 150)}`,
      recommendation: 'Repetir o controle antes de confiar no resultado.',
    });
    return;
  }
  const { proc: procI, dt: dtI } = invertedOutcome;
  const stdoutI = (procI.stdout || '').trim();
  const admitsNoAccessI = NO_ACCESS_RE.test(stdoutI);
  const answeredRedI = !admitsNoAccessI && ANSWERED_RED_RE.test(stdoutI);
  const answeredBlueI = !admitsNoAccessI && /\bazul|blue\b/i.test(stdoutI);

  // Ground truth: normal image top=red; inverted image top=blue. A CLI that
  // is really reading pixels should answer "vermelha" on normal AND "azul"
  // on inverted (flips). One that answers the SAME color both times, or
  // that can't access the file the second time either, is not reading it.
  const flipped = answeredRedN && answeredBlueI;
  results.push({
    transport: name,
    hasImage: flipped
      ? 'SIM — resposta acompanha a inversão da imagem (evidência forte de leitura real)'
      : (admitsNoAccessI
        ? 'NÃO — 1a chamada acertou por coincidência; 2a chamada (controle) admite falta de acesso'
        : 'NÃO — resposta NÃO acompanha a inversão (mesma cor nas duas imagens = alucinação/coincidência, não leitura real)'),
    mechanism: 'texto do prompt referenciando PATH absoluto (NÃO upload real de imagem)',
    evidence: `normal: exit=0 ${dtN}s stdout=${JSON.stringify(stdoutN).slice(0, 200)} | controle(invertido): exit=${procI.status} ${dtI}s stdout=${JSON.stringify(stdoutI).slice(0, 200)}`,
    recommendation: flipped
      ? 'Evidência de que a CLI consegue ler um arquivo local a partir do path em texto quando dentro do diretório permitido. Viável para Fase A SE o diretório de trabalho/allowlist cobrir onde os screenshots do reviewer serão salvos.'
      : 'Sem confirmação de leitura real de imagem via texto/path. NÃO prosseguir com Fase A neste transporte sem um mecanismo de anexo/upload comprovado.',
  });
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

await testHttpProvider('kimi');
await testHttpProvider('minimax');
await testHttpProvider('glm');

// claude --print: sem --dangerously-skip-permissions (spike não precisa de
// ferramentas, só resposta de texto), --print lê o prompt do stdin.
testCli('claude-cli', claudeBin, ['--print'], 180_000);

// codex exec --ignore-user-config: mesma justificativa de cli-invoker.ts —
// NÃO usar o bypass de sandbox (--dangerously-bypass-approvals-and-sandbox),
// spike só precisa de texto de volta. Timeout generoso (5 min).
testCli('codex-cli', codexBin, ['exec', '--ignore-user-config'], 300_000);

// ---------------------------------------------------------------------------
// Tabela-resumo
// ---------------------------------------------------------------------------

console.log('\n=== VISION SPIKE — TABELA-RESUMO ===\n');
const header = ['transporte', 'suporta imagem?', 'mecanismo', 'evidência (verbatim curta)', 'recomendação'];
console.log(header.join(' | '));
for (const r of results) {
  console.log([r.transport, r.hasImage, r.mechanism, r.evidence, r.recommendation].join(' | '));
}

console.log('\n[done] Consulte docs/VISION-SPIKE-2026-07-05.md para a versão formatada.');
