// Sprint P3 (Aurora-Redux, trilha P3, 2026-07-05): omniforge models — lista os
// modelos disponíveis de cada provedor direto configurado.
//
// Complementa `doctor` (que checa presença de env/key) com uma visão do
// CATÁLOGO de modelos vivo em cada provedor — útil para o operador/Sonnet
// escolherem um model_id válido antes de setar TASK_MODEL/REVIEWER_MODEL/etc.
//
// Fonte: listAllProviderModels() (src/utils/provider-models.ts), que já filtra
// por API key presente e nunca lança — cada provedor aparece com `models`,
// `error` ou (transportes CLI) uma `note` informativa.

import type { Command } from 'commander';
import { listAllProviderModels } from '../../utils/provider-models.js';
import type { ProviderModelsResult } from '../../utils/provider-models.js';

function isOk(r: ProviderModelsResult): r is Extract<ProviderModelsResult, { models: string[] }> {
  return 'models' in r;
}

function filterByProvider(results: ProviderModelsResult[], provider?: string): ProviderModelsResult[] {
  if (!provider) return results;
  const p = provider.toLowerCase();
  return results.filter((r) => r.provider.toLowerCase() === p);
}

/**
 * Renderiza a tabela texto provider → modelos (ou erro/nota). Quando a lista
 * está vazia (nenhuma key configurada e nenhuma entrada estática — cenário só
 * alcançável se listAllProviderModels() retornar []), mostra uma mensagem
 * amigável apontando para `omniforge doctor`.
 */
export function formatModelsTable(results: ProviderModelsResult[], provider?: string): string {
  const filtered = filterByProvider(results, provider);
  if (filtered.length === 0) {
    return [
      '',
      'Nenhum provedor configurado (nenhuma API key encontrada).',
      "Rode 'omniforge doctor' para checar quais envs de provedor estão faltando.",
      '',
    ].join('\n');
  }

  const lines: string[] = [''];
  for (const r of filtered) {
    if (isOk(r)) {
      const modelsStr = r.models.length > 0 ? r.models.join(', ') : '(nenhum modelo retornado)';
      const noteStr = r.note ? `  [${r.note}]` : '';
      lines.push(`  ${r.provider.padEnd(14)} ${modelsStr}${noteStr}`);
    } else {
      lines.push(`  ${r.provider.padEnd(14)} ERRO: ${r.error}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Serialização JSON (--json), filtrada por --provider quando presente. */
export function formatModelsJson(results: ProviderModelsResult[], provider?: string): string {
  return JSON.stringify(filterByProvider(results, provider), null, 2);
}

export function registerModels(program: Command): void {
  program
    .command('models')
    .description('List available models for each configured direct provider (kimi/minimax/glm + dynamic)')
    .option('--provider <name>', 'filter to a single provider by name')
    .option('--json', 'output raw JSON instead of a formatted table')
    .action(async (options: { provider?: string; json?: boolean }) => {
      const provider = options.provider;
      const results = await listAllProviderModels();
      // Filtra uma única vez — os formatters e a checagem de existência abaixo
      // reutilizam o resultado em vez de refazer o match por provider.
      const filtered = filterByProvider(results, provider);
      if (options.json) {
        console.log(formatModelsJson(filtered));
      } else {
        console.log(formatModelsTable(filtered));
      }
      // Fail loudly if a specific provider was requested but doesn't exist at all
      // (distinct from "exists but errored", which still prints its error line).
      if (provider && filtered.length === 0) {
        console.error(`Provedor desconhecido: ${provider}`);
        process.exitCode = 1;
      }
    });
}
