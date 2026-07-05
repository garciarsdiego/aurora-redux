// Direct OpenAI-compatible provider routing (Aurora-Redux, 2026-07-04).
//
// Purpose: let the single LLM chokepoint (`callOmnirouteWithUsage` in
// omniroute-call.ts) reach Kimi / MiniMax / GLM subscriptions DIRECTLY over
// their OpenAI-compatible endpoints, bypassing the external Omniroute service.
// A model id carrying a known prefix ('kimi/', 'minimax/', 'glm/') is routed
// here; anything else falls through to the legacy Omniroute path unchanged.
//
// Endpoints + native model ids verified by live smoke on 2026-07-04:
//   kimi/*    -> https://api.kimi.com/coding/v1/chat/completions       (kimi-for-coding)
//   minimax/* -> https://api.minimax.io/v1/chat/completions            (MiniMax-M3)
//   glm/*     -> https://api.z.ai/api/coding/paas/v4/chat/completions  (glm-5.2)
//
// Content shape notes (verified): Kimi + GLM return clean `content` with
// reasoning isolated in a separate `reasoning_content` field; MiniMax inlines
// its reasoning as a `<think>...</think>` block PREFIXED to `content`, which
// `extractContentRobust` strips.
//
// P2a (Aurora-Redux, trilha P2, 2026-07-05): preset `deepseek/` adicionado
// sobre https://api.deepseek.com/v1/chat/completions (deepseek-chat,
// deepseek-reasoner). Segue o mesmo contrato de `reasoning_content` isolado
// de Kimi/GLM (deepseek-reasoner usa esse campo) — compat, sem parsing novo.
// NÃO verificado por smoke E2E real ainda (pendente de DEEPSEEK_API_KEY do
// operador); apenas testes unitários de roteamento nesta trilha.
//
// P1a (Aurora-Redux, trilha P1, 2026-07-04): além dos 3 presets acima, QUALQUER
// par de envs `<NOME>_BASE_URL` + `<NOME>_API_KEY` registra por convenção um
// provedor direto sob o prefixo `nome.toLowerCase()/`. Isso deixa o operador
// plugar um provedor OpenAI-compatible novo sem tocar em código — só setando
// duas envs. Presets têm SEMPRE precedência (nome reservado, não pode ser
// "roubado" pela descoberta) e o namespace legado OMNIROUTE_* é blindado
// (nunca vira um provedor direto, mesmo que alguém sete OMNIROUTE_BASE_URL).

/** @deprecated Kept as an alias for callers that imported the old union type; the set of direct-provider names is now open-ended (dynamic discovery). */
export type DirectProviderName = string;

export interface DirectProviderRoute {
  providerName: DirectProviderName;
  /** Full base URL incl. version segment — NOT suffixed with /api/v1. */
  baseUrl: string;
  path: string;
  /** Env var holding the Bearer key for this provider. */
  envVar: string;
  /** Env var allowing base-URL override (optional). */
  baseUrlEnvVar: string;
}

const PRESET_ROUTES: Record<string, DirectProviderRoute> = {
  kimi: {
    providerName: 'kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    path: '/chat/completions',
    envVar: 'KIMI_API_KEY',
    baseUrlEnvVar: 'KIMI_BASE_URL',
  },
  minimax: {
    providerName: 'minimax',
    baseUrl: 'https://api.minimax.io/v1',
    path: '/chat/completions',
    envVar: 'MINIMAX_API_KEY',
    baseUrlEnvVar: 'MINIMAX_BASE_URL',
  },
  glm: {
    providerName: 'glm',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    path: '/chat/completions',
    envVar: 'GLM_API_KEY',
    baseUrlEnvVar: 'GLM_BASE_URL',
  },
  // P2a (Aurora-Redux, trilha P2, 2026-07-05): preset DeepSeek — habilita o
  // prefixo `deepseek/` (ex.: deepseek/deepseek-chat, deepseek/deepseek-reasoner)
  // sobre o endpoint OpenAI-compatible oficial. Puramente aditivo — mesmo
  // formato exato dos presets acima. extractContentRobust já isola
  // `reasoning_content` (contrato compartilhado com kimi/glm), então nenhum
  // parsing novo é necessário para o modelo deepseek-reasoner.
  deepseek: {
    providerName: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    path: '/chat/completions',
    envVar: 'DEEPSEEK_API_KEY',
    baseUrlEnvVar: 'DEEPSEEK_BASE_URL',
  },
};

// NOME válido por convenção: começa com letra, resto letras/dígitos/underscore
// (sem hífen — hífen não é um caractere válido de nome de env var POSIX/dotenv
// de qualquer forma). Casa o prefixo de `<NOME>_BASE_URL`.
const BASE_URL_ENV_RE = /^([A-Z][A-Z0-9_]*)_BASE_URL$/;

// Namespace legado — nunca deve virar um provedor direto por convenção, mesmo
// que OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY existam (o legado usa OMNIROUTE_URL,
// mas blindamos o nome inteiro por precaução).
const RESERVED_NAMES = new Set(['OMNIROUTE']);

/**
 * Varre process.env por `<NOME>_BASE_URL` e monta as rotas dinâmicas
 * correspondentes. Por-chamada (barato: só string ops sobre as chaves já em
 * memória) para que testes que mutam process.env em beforeEach/afterEach vejam
 * o efeito sem precisar de um reset explícito de cache.
 *
 * Registro é gated SÓ por `<NOME>_BASE_URL` presente — a API key pode estar
 * ausente (é exatamente esse o cenário que o doctor precisa detectar e
 * reportar como fail: "provedor configurado, key faltando"). Um provedor sem
 * key ainda aparece em listDirectProviderRoutes() com `envVar` apontando para
 * a env correta; getDirectProviderApiKey() simplesmente retorna '' nesse caso
 * e o caller HTTP falha adiante com a mensagem de key ausente — o mesmo
 * contrato que os presets kimi/minimax/glm já tinham.
 */
function discoverDynamicRoutes(): Record<string, DirectProviderRoute> {
  const out: Record<string, DirectProviderRoute> = {};
  for (const key of Object.keys(process.env)) {
    const match = BASE_URL_ENV_RE.exec(key);
    if (!match) continue;
    const name = match[1];
    if (RESERVED_NAMES.has(name)) continue;
    const prefix = name.toLowerCase();
    if (Object.hasOwn(PRESET_ROUTES, prefix)) continue; // presets têm precedência
    const baseUrl = process.env[key]?.trim();
    if (!baseUrl) continue; // <NOME>_BASE_URL vazio/whitespace — não registra
    const pathOverride = process.env[`${name}_PATH`]?.trim();
    out[prefix] = {
      providerName: prefix,
      baseUrl,
      path: pathOverride || '/chat/completions',
      envVar: `${name}_API_KEY`,
      baseUrlEnvVar: key,
    };
  }
  return out;
}

/**
 * Todas as rotas registráveis no momento da chamada: presets primeiro, depois
 * as descobertas dinamicamente (presets nunca são sobrescritos). Lista TODAS
 * as rotas com par completo — quem consome (doctor/strip/models) filtra por
 * key presente/ausente conforme sua necessidade.
 */
export function listDirectProviderRoutes(): DirectProviderRoute[] {
  return [...Object.values(PRESET_ROUTES), ...Object.values(discoverDynamicRoutes())];
}

/**
 * Resolve a model id to a direct provider route by prefix, or null if the id
 * carries no known direct prefix (→ legacy Omniroute path). Presets first,
 * then dynamic discovery — case-insensitive on the prefix either way.
 */
export function resolveDirectProviderRoute(model: string): DirectProviderRoute | null {
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  // Lowercase: paridade com os regexes /i de isCliModel — 'Kimi/x' e 'kimi/x'
  // precisam rotear idêntico. (BAIXO-3, revisão 2026-07-04.)
  const prefix = model.slice(0, slash).toLowerCase();
  // Object.hasOwn guards against prototype keys ('constructor/x' etc.). (B1.)
  if (Object.hasOwn(PRESET_ROUTES, prefix)) return PRESET_ROUTES[prefix];
  const dynamic = discoverDynamicRoutes();
  return Object.hasOwn(dynamic, prefix) ? dynamic[prefix] : null;
}

/** Strip the routing prefix so the provider receives its native model id. */
export function stripRoutePrefix(model: string, route: DirectProviderRoute): string {
  const slash = model.indexOf('/');
  if (slash <= 0) return model;
  return model.slice(0, slash).toLowerCase() === route.providerName
    ? model.slice(slash + 1)
    : model;
}

/** Build the full completions URL, honoring an optional per-provider override. */
export function buildDirectProviderUrl(route: DirectProviderRoute): string {
  const base = (process.env[route.baseUrlEnvVar]?.trim() || route.baseUrl).replace(/\/+$/, '');
  return `${base}${route.path}`;
}

/** Read the Bearer key for a direct provider from its env var. */
export function getDirectProviderApiKey(route: DirectProviderRoute): string {
  return process.env[route.envVar]?.trim() ?? '';
}

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>\s*/gi;

/** Remove inline `<think>...</think>` reasoning blocks (MiniMax). */
export function stripThinkBlock(content: string): string {
  return content.replace(THINK_BLOCK_RE, '').trim();
}

/**
 * Content extractor for direct-provider responses. Primary source is
 * `choices[0].message.content`; inline `<think>` blocks are stripped. Mirrors
 * the legacy `extractContent` contract: returns null when there is no usable
 * visible content (e.g. reasoning consumed the whole budget), so the caller
 * raises the same explicit "missing content shape" error instead of silently
 * promoting raw reasoning as the answer.
 */
export function extractContentRobust(json: unknown): string | null {
  const data = json as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const message = data?.choices?.[0]?.message;
  if (!message) return null;
  let content = message.content ?? '';
  if (content.includes('<think>')) content = stripThinkBlock(content);
  // If a <think> tag survives the strip, the block was never closed (stream
  // truncated mid-reasoning) — returning the raw reasoning would feed garbage
  // to the downstream JSON parser. Return null so the caller raises the clear
  // "missing content shape" error and retries instead. (Review finding M1.)
  if (content.includes('<think>')) return null;
  content = content.trim();
  return content !== '' ? content : null;
}
