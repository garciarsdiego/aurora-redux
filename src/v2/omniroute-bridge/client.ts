import {
  getOmnirouteUrl,
  getOmnirouteApiKey,
  getOmnirouteDefaultModel,
  getOmnirouteMaxTokens,
  getOmnirouteMaxContinuations,
  getOmnirouteUseResponsesApi,
  getOmnirouteFallbackModels,
} from '../../utils/config.js';

const TIMEOUT_MS = 5000;

export interface BridgeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface QuotaResult {
  allowed: boolean;
  remaining_pct: number;
}

export interface CostReportEntry {
  task_id: string;
  cost_usd: number;
}

export interface CostReportResult {
  total_usd: number;
  by_task: CostReportEntry[];
}

export interface BestComboResult {
  model: string;
  tier: string;
}

export interface MemorySearchResult {
  results: string[];
}

export interface WebSearchResult {
  results: string[];
}

// ── Health Monitoring API ─────────────────────────────────────────────────────

export interface BasicHealthResult {
  status: 'ok' | 'error';
  timestamp: string;
}

export interface ProviderHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency_ms: number;
  last_check: string;
}

export interface RateLimitStatus {
  remaining: number;
  reset_in: number; // seconds
}

export interface DetailedHealthResult {
  status: 'ok' | 'error';
  timestamp: string;
  providers: Record<string, ProviderHealthStatus>;
  rate_limits: Record<string, RateLimitStatus>;
}

export interface HealthCheckResult {
  ok: boolean;
  data?: DetailedHealthResult;
  error?: string;
}

function quotaFallback(): QuotaResult {
  if (process.env.OMNIFORGE_QUOTA_FAIL_OPEN === 'true') {
    return { allowed: true, remaining_pct: 100 };
  }
  return { allowed: false, remaining_pct: 0 };
}

/**
 * Bridge endpoints (cost-report, quota, best-combo, …) require Omniroute's
 * MANAGEMENT token, which is distinct from the chat-completions API key.
 * Many local-dev / single-operator setups only configure the API key, so
 * these endpoints return 403 "Invalid management token" on every workflow.
 *
 * Suppress the 403 noise to debug-level when the operator clearly hasn't
 * configured a management token (or the management surface). Other
 * statuses (4xx≠403, 5xx, network errors) still surface as console.error.
 *
 * Operator opt-in: set `OMNIFORGE_BRIDGE_VERBOSE=true` to log everything.
 */
function logBridgeError(label: string, status: number, body: string): void {
  const message = `[omniroute-bridge] ${label}: HTTP ${status} — ${body.slice(0, 200)}`;
  const verbose = process.env.OMNIFORGE_BRIDGE_VERBOSE === 'true';
  const isManagementAuth = status === 403 && /management token|AUTH_001/i.test(body);
  if (isManagementAuth && !verbose) {
    // Quiet path — single-line stderr at debug level so operators can grep.
    process.stderr.write(`[omniroute-bridge:debug] ${label}: management endpoint unavailable (403). ` +
      `Set OMNIFORGE_BRIDGE_VERBOSE=true for full payload.\n`);
    return;
  }
  console.error(message);
}

async function call<T>(
  endpoint: string,
  body: unknown,
  fallback: T,
  label: string,
): Promise<BridgeResult<T>> {
  const url = `${getOmnirouteUrl()}${endpoint}`;
  // Defense in depth — if Omniroute starts requiring auth on /api/* later
  // these calls keep working without code change.
  const apiKey = getOmnirouteApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      logBridgeError(label, res.status, text);
      return { ok: false, data: fallback, error: `[omniroute-bridge] ${label}: HTTP ${res.status}` };
    }
    const data = await res.json() as T;
    return { ok: true, data };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const msg = isTimeout
      ? `[omniroute-bridge] ${label}: timeout after ${TIMEOUT_MS}ms`
      : `[omniroute-bridge] ${label}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    return { ok: false, data: fallback, error: msg };
  }
}

export async function checkQuota(workspace: string): Promise<BridgeResult<QuotaResult>> {
  return call<QuotaResult>(
    '/api/quota',
    { workspace },
    quotaFallback(),
    'check_quota',
  );
}

export async function costReport(workflow_id: string): Promise<BridgeResult<CostReportResult>> {
  return call<CostReportResult>(
    '/api/cost-report',
    { workflow_id },
    { total_usd: 0, by_task: [] },
    'cost_report',
  );
}

export async function bestComboForTask(
  task_kind: string,
  complexity: string,
): Promise<BridgeResult<BestComboResult>> {
  return call<BestComboResult>(
    '/api/best-combo',
    { task_kind, complexity },
    { model: 'cc/claude-haiku-4-5-20251001', tier: 'standard' },
    'best_combo_for_task',
  );
}

export async function memorySearch(
  query: string,
  workspace: string,
): Promise<BridgeResult<MemorySearchResult>> {
  return call<MemorySearchResult>(
    '/api/memory/search',
    { query, workspace },
    { results: [] },
    'memory_search',
  );
}

export async function webSearch(query: string): Promise<BridgeResult<WebSearchResult>> {
  return call<WebSearchResult>(
    '/api/web-search',
    { query },
    { results: [] },
    'web_search',
  );
}

// ── Omniroute streaming / catalog API ─────────────────────────────────────────
// Ported from zinho-port commit 127cb72 (editorial-console/server/lib/omniroute.js).
// URL convention: getOmnirouteConfig() appends /v1 to OMNIROUTE_URL so
// OpenAI-compat endpoints (/models, /chat/completions, /responses) route
// correctly. The existing /api/* bridge calls above use getOmnirouteUrl()
// directly and are unaffected. .env.example unchanged.

export interface OmnirouteStreamConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  maxContinuations: number;
  useResponsesApi: boolean;
  fallbackModels: string[];
}

export interface RawModel {
  id: string;
  [key: string]: unknown;
}

export interface RawModelGroup {
  provider: string;
  models: RawModel[];
}

export interface FetchModelsResult {
  enabled: boolean;
  groups: RawModelGroup[];
  models: RawModel[];
  defaultModel: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: string | { url: string } }>;
}

export interface StreamPartResult {
  finishReason: string | null;
  api: 'chat.completions' | 'responses';
  usage?: unknown;
}

export interface StreamChatOpts {
  model?: string;
  messages: ChatMessage[];
  onToken: (token: string) => void;
  onMeta?: (meta: Record<string, unknown>) => void;
}

interface _StreamPartOpts {
  config: OmnirouteStreamConfig;
  model: string;
  messages: ChatMessage[];
  onToken: (token: string) => void;
  onMeta?: (meta: Record<string, unknown>) => void;
}

// Cache keyed by `${baseUrl}` (one canonical key in practice, but the Map
// pattern keeps the contract open for future per-workspace base URLs). FIFO
// eviction protects against unbounded growth when callers slot in distinct
// keys (test workers, alt-baseUrl scenarios, etc.). Default cap 100 mirrors
// the LRU policy applied to conversation memory (commit 9f2a37d follow-up);
// override with OMNIROUTE_MODEL_CACHE_SIZE for synthetic workloads.
const _modelCacheMap = new Map<string, { at: number; payload: FetchModelsResult }>();
const _MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const _DEFAULT_MODEL_CACHE_SIZE = 100;

function _getModelCacheMaxSize(): number {
  const raw = process.env.OMNIROUTE_MODEL_CACHE_SIZE;
  if (!raw) return _DEFAULT_MODEL_CACHE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return _DEFAULT_MODEL_CACHE_SIZE;
  return parsed;
}

function _evictModelCacheIfNeeded(): void {
  const cap = _getModelCacheMaxSize();
  while (_modelCacheMap.size > cap) {
    const oldestKey = _modelCacheMap.keys().next().value;
    if (oldestKey === undefined) return;
    _modelCacheMap.delete(oldestKey);
  }
}

/** Test-only: returns cache size for assertions. */
export function _getModelCacheSize(): number {
  return _modelCacheMap.size;
}

/** Test-only: clears the cache. */
export function _resetModelCache(): void {
  _modelCacheMap.clear();
}

export function getOmnirouteConfig(): OmnirouteStreamConfig {
  const base = getOmnirouteUrl().replace(/\/$/, '');
  return {
    baseUrl: `${base}/v1`,
    apiKey: getOmnirouteApiKey(),
    defaultModel: getOmnirouteDefaultModel(),
    maxTokens: getOmnirouteMaxTokens(),
    maxContinuations: getOmnirouteMaxContinuations(),
    useResponsesApi: getOmnirouteUseResponsesApi(),
    fallbackModels: getOmnirouteFallbackModels(),
  };
}

export async function fetchModels({ force = false } = {}): Promise<FetchModelsResult> {
  const config = getOmnirouteConfig();

  if (!config.apiKey) {
    return { enabled: false, groups: [], models: [], defaultModel: config.defaultModel };
  }

  const cacheKey = config.baseUrl;
  const now = Date.now();
  const cached = _modelCacheMap.get(cacheKey);
  if (!force && cached && now - cached.at < _MODEL_CACHE_TTL_MS) {
    return cached.payload;
  }

  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`Omniroute models ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as { data?: RawModel[]; models?: RawModel[] };
  const rawModels: RawModel[] = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
    ? payload.models
    : [];

  const groups = _groupRawModels(rawModels);
  const result: FetchModelsResult = { enabled: true, ...groups, defaultModel: config.defaultModel };
  _modelCacheMap.set(cacheKey, { at: now, payload: result });
  _evictModelCacheIfNeeded();
  return result;
}

function _groupRawModels(rawModels: RawModel[]): { groups: RawModelGroup[]; models: RawModel[] } {
  const providerMap = new Map<string, RawModel[]>();
  for (const model of rawModels) {
    const id = String(model['id'] ?? '');
    const slashIdx = id.indexOf('/');
    const provider = slashIdx > -1 ? id.slice(0, slashIdx) : 'unknown';
    const existing = providerMap.get(provider) ?? [];
    existing.push(model);
    providerMap.set(provider, existing);
  }
  const groups: RawModelGroup[] = Array.from(providerMap.entries())
    .sort(([a], [b]) => a.localeCompare(b, 'pt-BR'))
    .map(([provider, models]) => ({ provider, models }));
  return { groups, models: rawModels };
}

export async function streamChat({ model, messages, onToken, onMeta }: StreamChatOpts): Promise<string> {
  const config = getOmnirouteConfig();
  const primary = model ?? config.defaultModel;
  const candidates = [...new Set([primary, ...config.fallbackModels].filter(Boolean))];
  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      onMeta?.({ model: candidate });
      let fullText = '';
      let nextMessages = messages;

      for (let partIndex = 0; partIndex <= config.maxContinuations; partIndex += 1) {
        if (partIndex > 0) {
          const marker = `\n\n---\n\n**Continuação ${partIndex + 1}**\n\n`;
          fullText += marker;
          onToken(marker);
          onMeta?.({ model: candidate, continuation: partIndex + 1 });
        }

        const result = await streamCompletionPartWithFallback({
          config,
          model: candidate,
          messages: nextMessages,
          onMeta,
          onToken: (token: string) => { fullText += token; onToken(token); },
        });

        if (result.finishReason !== 'length') return fullText;

        nextMessages = [
          ...messages,
          { role: 'assistant' as const, content: fullText },
          {
            role: 'user' as const,
            content: 'Continue exatamente de onde parou. Nao repita o que ja escreveu. Se ainda faltar espaco, encerre em um ponto seguro para nova continuacao.',
          },
        ];

        if (partIndex === config.maxContinuations) {
          const warning = '\n\n[Resposta interrompida pelo limite do provedor. Peça para continuar se quiser seguir deste ponto.]';
          fullText += warning;
          onToken(warning);
        }
      }

      return fullText;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`All Omniroute models failed: ${failures.join(' | ')}`);
}

export async function streamCompletionPartWithFallback(opts: _StreamPartOpts): Promise<StreamPartResult> {
  const { config, onMeta } = opts;
  if (!config.useResponsesApi) {
    onMeta?.({ api: 'chat.completions' });
    return _streamChatCompletionPart(opts);
  }
  try {
    onMeta?.({ api: 'responses' });
    return await _streamResponsesCompletionPart(opts);
  } catch (error) {
    onMeta?.({ api: 'chat.completions', responsesFallback: error instanceof Error ? error.message : String(error) });
    return _streamChatCompletionPart(opts);
  }
}

async function _streamChatCompletionPart({ config, model, messages, onToken }: _StreamPartOpts): Promise<StreamPartResult> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7, max_tokens: config.maxTokens }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split('\n').filter((l) => l.startsWith('data:'))) {
        const data = line.replace(/^data:\s*/, '');
        if (data === '[DONE]') return { finishReason, api: 'chat.completions' };
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
          const choice = chunk.choices?.[0] ?? {};
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const text = choice.delta?.content ?? '';
          if (text) onToken(text);
        } catch { /* keepalive */ }
      }
    }
  }
  return { finishReason, api: 'chat.completions' };
}

async function _streamResponsesCompletionPart({ config, model, messages, onToken }: _StreamPartOpts): Promise<StreamPartResult> {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');

  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: _normalizeResponsesContent(m.content) }));

  const response = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, instructions, input, stream: true, max_output_tokens: config.maxTokens }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`responses ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let usage: unknown = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split('\n').filter((l) => l.startsWith('data:'))) {
        const data = line.replace(/^data:\s*/, '');
        if (data === '[DONE]') return { finishReason, api: 'responses', usage };
        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          const token = _extractResponsesDelta(event);
          if (token) onToken(token);
          const resp = event['response'] as Record<string, unknown> | undefined;
          if (resp?.['status'] === 'completed') finishReason = 'stop';
          usage = resp?.['usage'] ?? event['usage'] ?? usage;
        } catch { /* SSE keepalive */ }
      }
    }
  }
  return { finishReason, api: 'responses', usage };
}

function _normalizeResponsesContent(
  content: ChatMessage['content'],
): Array<{ type: string; text?: string; image_url?: string }> {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === 'text') return { type: 'input_text', text: part.text ?? '' };
      if (part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? '';
        return { type: 'input_image', image_url: url };
      }
      return { type: 'input_text', text: JSON.stringify(part) };
    });
  }
  return [{ type: 'input_text', text: String(content ?? '') }];
}

function _extractResponsesDelta(event: Record<string, unknown>): string {
  if (event['type'] === 'response.output_text.delta') return String(event['delta'] ?? '');
  if (event['type'] === 'response.output_item.delta') return String((event['delta'] as Record<string, unknown>)?.['text'] ?? '');
  if (event['type'] === 'response.content_part.delta') {
    const d = event['delta'];
    return typeof d === 'string' ? d : String((d as Record<string, unknown>)?.['text'] ?? '');
  }
  const d = event['delta'] as Record<string, unknown> | undefined;
  return String(d?.['text'] ?? event['output_text_delta'] ?? '');
}

// ── Health Check Functions ──────────────────────────────────────────────────────

const HEALTH_TIMEOUT_MS = 3000; // Health checks should be fast

function basicHealthFallback(): BasicHealthResult {
  return { status: 'error', timestamp: new Date().toISOString() };
}

function detailedHealthFallback(): DetailedHealthResult {
  return {
    status: 'error',
    timestamp: new Date().toISOString(),
    providers: {},
    rate_limits: {},
  };
}

/**
 * Basic health check - returns quickly with minimal information
 * Use for liveness probes
 */
export async function checkBasicHealth(): Promise<BridgeResult<BasicHealthResult>> {
  const url = `${getOmnirouteUrl()}/api/health`;
  const apiKey = getOmnirouteApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      logBridgeError('basic_health', res.status, text);
      return { ok: false, data: basicHealthFallback(), error: `HTTP ${res.status}` };
    }

    const data = await res.json() as BasicHealthResult;
    return { ok: true, data };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const msg = isTimeout
      ? `basic_health: timeout after ${HEALTH_TIMEOUT_MS}ms`
      : `basic_health: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[omniroute-bridge] ${msg}`);
    return { ok: false, data: basicHealthFallback(), error: msg };
  }
}

/**
 * Detailed health check - returns provider status and rate limits
 * Use for health monitoring and failover decisions
 */
export async function checkDetailedHealth(): Promise<HealthCheckResult> {
  const url = `${getOmnirouteUrl()}/api/monitoring/health`;
  const apiKey = getOmnirouteApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '<unreadable>');
      logBridgeError('detailed_health', res.status, text);
      return {
        ok: false,
        data: detailedHealthFallback(),
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json() as DetailedHealthResult;
    return { ok: true, data };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const msg = isTimeout
      ? `detailed_health: timeout after ${HEALTH_TIMEOUT_MS}ms`
      : `detailed_health: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[omniroute-bridge] ${msg}`);
    return {
      ok: false,
      data: detailedHealthFallback(),
      error: msg,
    };
  }
}
