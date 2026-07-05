import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';

describe('spawnCliCollect — abort na entrada não deixa child error sem listener', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejeita com AbortError e não emite uncaughtException quando signal já está abortado', async () => {
    // Bin "real" que existe (honrado por claudeBin via existsSync) mas cujo
    // spawn cria o child com sucesso de forma síncrona e SÓ ENTÃO emite um
    // 'error' assíncrono — reproduzindo o cenário MÉDIO-1 (workflow abortado +
    // bin quebrado). Um diretório serve: no Windows/Linux `spawn(dir)` retorna
    // um child e dispara ENOENT no próximo tick (um arquivo .bin não-executável
    // falharia SÍNCRONO no Windows — spawn EFTYPE — e não exercitaria o branch
    // de abort-na-entrada com um child já criado, que é o ponto do fix).
    const dir = mkdtempSync(join(tmpdir(), 'cli-invoker-test-'));
    const marker = join(dir, 'not-a-real-cli.bin');
    writeFileSync(marker, 'not executable');
    process.env.CLI_CLAUDE_BIN = dir;

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);

    try {
      const { callViaCli } = await import('../../src/utils/cli-invoker.js');
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        callViaCli({
          systemPrompt: 's',
          userPrompt: 'u',
          model: 'claude-cli/',
          signal: ctrl.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // Dá um tick para o evento 'error' assíncrono do spawn disparar.
      await new Promise((r) => setTimeout(r, 200));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      delete process.env.CLI_CLAUDE_BIN;
    }
  }, 15_000);
});

// MÉDIO-2 (revisão adversarial 2026-07-04): matar a árvore de processos, não só
// o filho direto. Win32-only porque o fix (taskkill /T /F) é específico do
// Windows — em POSIX o comportamento continua sendo kill direto.
describe.runIf(process.platform === 'win32')('killProcessTree', () => {
  it('mata neto spawnado via cmd.exe (árvore inteira)', async () => {
    const { killProcessTree } = await import('../../src/utils/cli-invoker.js');
    // cmd.exe -> node (neto) que dorme 30s com um marcador no argv.
    const marker = `killtree-test-${Date.now()}`;
    // Par de aspas EXTERNO obrigatório: `cmd /s /c` remove só o primeiro e o
    // último caractere-aspa da string inteira. Se process.execPath tem espaços
    // (ex.: "C:\Program Files\nodejs\node.exe" numa instalação padrão do
    // Windows), sem o par externo o /s comeria as aspas do próprio path do node
    // e o cmd tentaria rodar `C:\Program` — o neto nunca nasceria e o teste
    // passaria vácuo. Com o par externo, o /s tira só ele e as aspas internas
    // sobrevivem intactas. (verificado empiricamente 2026-07-04.)
    const child = spawn('cmd.exe', ['/d', '/s', '/c',
      `""${process.execPath}" -e "setTimeout(()=>{}, 30000) // ${marker}""`,
    ], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    // windowsVerbatimArguments: sem isso o Node aplica quoting estilo MSVC que
    // o cmd.exe não entende — o neto poderia nem nascer e o teste passaria vazio.
    await new Promise((r) => setTimeout(r, 1500)); // deixa o neto nascer

    // Pré-check de robustez: o neto PRECISA existir antes do kill, senão o
    // teste passaria vacuamente (count 0 antes e depois). Query reutilizada.
    // I1: restrita a node.exe — match por substring na CommandLine pegaria
    // qualquer processo da máquina que carregue o marker (o cmd.exe
    // intermediário, wrappers de shell da própria query); o neto que interessa
    // É node.exe. O @() força array para que .Count seja 0 (e não vazio)
    // quando nada casa.
    const countGrandchild = (): number => {
      const out = execSync(
        `powershell -NoProfile -Command "(@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID })).Count"`,
        { encoding: 'utf8' },
      ).trim();
      // M2: uma falha da query CIM não pode se disfarçar de sucesso — a saída
      // precisa ser um inteiro puro, senão falha alto com a saída crua.
      if (!/^\d+$/.test(out)) {
        throw new Error(
          `query CIM retornou saída inesperada (esperava inteiro): ${JSON.stringify(out)}`,
        );
      }
      return Number(out);
    };
    const before = countGrandchild();
    if (before < 1) {
      // Cleanup best-effort antes de falhar para não vazar o cmd.exe.
      killProcessTree(child);
      throw new Error(
        `pré-check falhou: neto (marker ${marker}) não nasceu — teste seria vácuo`,
      );
    }

    killProcessTree(child);

    // M1: poll com retry em vez de sleep cego — o taskkill age de forma
    // assíncrona do ponto de vista do teste. Passa assim que a árvore zerar;
    // falha se ainda houver sobrevivente depois de 5s.
    const deadline = Date.now() + 5_000;
    let remaining = countGrandchild();
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      remaining = countGrandchild();
    }
    expect(remaining).toBe(0);
  }, 20_000);
});

describe('resolveCliSpec — codex brain-role roda contido', () => {
  it('não passa bypass de sandbox e mantém --ignore-user-config', async () => {
    const { resolveCliSpec } = await import('../../src/utils/cli-invoker.js');
    const spec = resolveCliSpec('codex-cli/gpt-5.5');
    expect(spec.args).toContain('exec');
    expect(spec.args).toContain('--model');
    expect(spec.args).toContain('gpt-5.5');
    expect(spec.args).toContain('--ignore-user-config');
    expect(spec.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('extractCliContent — fallback codex', () => {
  it('mantém linhas de conteúdo que começam com número', async () => {
    const { extractCliContent } = await import('../../src/utils/cli-invoker.js');
    // Sem marcador 'codex' → cai no fallback de strip de chrome.
    const raw = [
      'workdir: C:\\x',
      'model: gpt-5.5',
      '3 passos necessários para a correção',
      '1,024 itens processados no lote',
      'tokens used',
      '4,821',
    ].join('\n');
    const out = extractCliContent(raw, 'codex');
    expect(out).toContain('3 passos necessários');
    expect(out).toContain('1,024 itens processados');
    expect(out).not.toContain('tokens used');
    expect(out).not.toMatch(/^4,821$/m);
  });

  it('deduplica resposta emitida 2x idêntica no mesmo bloco', async () => {
    const { extractCliContent } = await import('../../src/utils/cli-invoker.js');
    const answer = '{"ok": true, "n": 7}';
    const raw = ['codex', answer, answer, 'tokens used', '123'].join('\n');
    expect(extractCliContent(raw, 'codex')).toBe(answer);
  });

  it('NÃO deduplica quando as metades diferem', async () => {
    const { extractCliContent } = await import('../../src/utils/cli-invoker.js');
    const raw = ['codex', 'parte A', 'parte B', 'tokens used', '9'].join('\n');
    expect(extractCliContent(raw, 'codex')).toBe('parte A\nparte B');
  });
});

describe('stripProviderKeysFromEnv', () => {
  it('remove as keys de provedor e preserva o resto', async () => {
    const { stripProviderKeysFromEnv } = await import('../../src/utils/cli-invoker.js');
    const env = {
      KIMI_API_KEY: 'k', MINIMAX_API_KEY: 'm', GLM_API_KEY: 'g',
      OMNIROUTE_API_KEY: 'o', PATH: '/bin', NO_COLOR: '1',
    };
    const out = stripProviderKeysFromEnv(env);
    expect(out.KIMI_API_KEY).toBeUndefined();
    expect(out.MINIMAX_API_KEY).toBeUndefined();
    expect(out.GLM_API_KEY).toBeUndefined();
    expect(out.OMNIROUTE_API_KEY).toBeUndefined();
    expect(out.PATH).toBe('/bin');
    expect(out.NO_COLOR).toBe('1');
    // Imutabilidade: o objeto original não é mutado.
    expect(env.KIMI_API_KEY).toBe('k');
  });
});
