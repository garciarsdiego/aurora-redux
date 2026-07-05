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

export type DirectProviderName = 'kimi' | 'minimax' | 'glm';

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

const DIRECT_PROVIDER_ROUTES: Record<DirectProviderName, DirectProviderRoute> = {
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
};

/**
 * Resolve a model id to a direct provider route by prefix, or null if the id
 * carries no known direct prefix (→ legacy Omniroute path).
 */
export function resolveDirectProviderRoute(model: string): DirectProviderRoute | null {
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  // Lowercase: paridade com os regexes /i de isCliModel — 'Kimi/x' e 'kimi/x'
  // precisam rotear idêntico. (BAIXO-3, revisão 2026-07-04.)
  const prefix = model.slice(0, slash).toLowerCase();
  // Object.hasOwn guards against prototype keys ('constructor/x' etc.). (B1.)
  return Object.hasOwn(DIRECT_PROVIDER_ROUTES, prefix)
    ? DIRECT_PROVIDER_ROUTES[prefix as DirectProviderName]
    : null;
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
