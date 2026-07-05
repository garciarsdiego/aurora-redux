// Fetch de modelos por provedor direto (Aurora-Redux, trilha P3, 2026-07-05).
//
// Purpose: dar ao operador/Sonnet visibilidade sobre quais modelos estão
// disponíveis em cada provedor direto configurado (kimi/minimax/glm +
// descoberta dinâmica), sem precisar consultar a documentação de cada um
// manualmente. Consome listDirectProviderRoutes() de provider-routes.ts —
// nunca duplica a lógica de resolução/descoberta de rotas.
//
// Contrato de erro: fetchProviderModels() e listAllProviderModels() NUNCA
// lançam para o chamador — toda falha (HTTP não-2xx, timeout, shape
// inesperado, exceção de rede) vira um resultado `{provider, error}`. Isso
// permite ao CLI/MCP renderizar uma tabela completa mesmo quando alguns
// provedores estão fora do ar.

import { listDirectProviderRoutes, buildDirectProviderUrl, getDirectProviderApiKey } from './provider-routes.js';
import type { DirectProviderRoute } from './provider-routes.js';

export interface ProviderModelsOk {
  provider: string;
  models: string[];
  /** Present only for informational CLI-transport entries (no live /models call). */
  note?: string;
}

export interface ProviderModelsErr {
  provider: string;
  error: string;
}

export type ProviderModelsResult = ProviderModelsOk | ProviderModelsErr;

// Transportes CLI (spawn de binário local via OAuth de sessão) não expõem um
// endpoint HTTP /models — não têm rota em provider-routes.ts (que só cobre
// provedores OpenAI-compat diretos), então são listados aqui como entradas
// estáticas informativas, nunca como erro.
const CLI_TRANSPORT_NOTES: Record<string, string> = {
  'claude-cli': 'CLI OAuth — modelo da sessão logada',
  'codex-cli': 'CLI OAuth — modelo da sessão logada',
};

const FETCH_TIMEOUT_MS = 8000;

/** Deriva a URL de listagem de modelos a partir da base do route (sem o path de /chat/completions). */
function buildModelsUrl(route: DirectProviderRoute): string {
  const completionsUrl = buildDirectProviderUrl(route);
  // completionsUrl = base + route.path (ex.: '/chat/completions'). Removemos
  // o path para chegar na base "crua" e anexamos '/models'.
  const base = completionsUrl.endsWith(route.path)
    ? completionsUrl.slice(0, completionsUrl.length - route.path.length)
    : completionsUrl.replace(/\/chat\/completions$/, '');
  return `${base.replace(/\/+$/, '')}/models`;
}

/** Parse de shape OpenAI-compat: { data: [{id}, ...] }. */
function parseModelsResponse(json: unknown): string[] | null {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id === 'string' && id.trim() !== '') ids.push(id);
  }
  return ids;
}

/**
 * Busca a lista de modelos de UM provedor direto via HTTP GET em
 * `${base}/models`. Nunca lança: toda falha vira {provider, error}.
 */
export async function fetchProviderModels(route: DirectProviderRoute): Promise<ProviderModelsResult> {
  const url = buildModelsUrl(route);
  const apiKey = getDirectProviderApiKey(route);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { provider: route.providerName, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const models = parseModelsResponse(json);
    if (models === null) {
      return { provider: route.providerName, error: 'unexpected response shape (missing data[] array)' };
    }
    return { provider: route.providerName, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { provider: route.providerName, error: msg };
  }
}

// Cache TTL em memória — evita re-bater em todos os provedores a cada
// chamada (ex.: CLI invocado repetidamente ou MCP tool consultada em loop).
// Best-effort: nunca é a fonte de verdade, só reduz tráfego redundante.
const CACHE_TTL_MS = 60_000;
let cache: { at: number; result: ProviderModelsResult[] } | null = null;

/** Limpa o cache em memória — usado por testes para isolamento entre casos. */
export function clearProviderModelsCache(): void {
  cache = null;
}

/**
 * Agrega os resultados de fetchProviderModels() para todas as rotas diretas
 * que têm API key presente, em paralelo (Promise.allSettled — uma falha
 * individual nunca derruba as demais). Transportes CLI (sem endpoint HTTP)
 * são incluídos como entradas estáticas informativas.
 */
export async function listAllProviderModels(): Promise<ProviderModelsResult[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.result;

  const routesWithKey = listDirectProviderRoutes().filter(
    (route) => getDirectProviderApiKey(route) !== '',
  );

  const settled = await Promise.allSettled(routesWithKey.map((route) => fetchProviderModels(route)));
  const httpResults: ProviderModelsResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      // Promise.allSettled só rejeita se fetchProviderModels() em si lançar,
      // o que seu próprio try/catch já previne — este ramo é defensivo.
      : { provider: routesWithKey[i]!.providerName, error: String(s.reason) },
  );

  const cliResults: ProviderModelsResult[] = Object.entries(CLI_TRANSPORT_NOTES).map(
    ([provider, note]) => ({ provider, models: [], note }),
  );

  const result = [...httpResults, ...cliResults];
  cache = { at: now, result };
  return result;
}
