import crypto from 'node:crypto';
import { getOmnirouteUrl } from '../../utils/config.js';
import type {
  AdminFetchOptions,
  BuildIntelligenceInput,
  NormalizedModel,
  NormalizedProvider,
  NormalizedRateLimit,
  NormalizedUsage,
  OmnirouteCatalogEntry,
  OmnirouteCatalogResponse,
  OmnirouteIntelligence,
  OmniroutePricingEntry,
  OmnirouteProviderModelsResponse,
  OmnirouteProvidersResponse,
  OmnirouteRateLimitsResponse,
  OmnirouteRawConnection,
  OmnirouteRawModel,
  OmnirouteRawProviderHealth,
  OmnirouteRawRateLimit,
  OmnirouteRawUsage,
  OmnirouteTokenHealthResponse,
  OmnirouteUsageHistory,
  SafeConnection,
  UsageSummary,
  AccountLimit,
} from './admin-types.js';

const defaultAdminPassword = crypto.randomUUID();
let cachedCookie: { cookie: string; expiresAt: number } | null = null;

export function getAdminConfig() {
  const baseUrl = (process.env.OMNIROUTE_ADMIN_BASE_URL || getOmnirouteUrl())
    .replace(/\/v1$/, "")
    .replace(/\/$/, "");
  return {
    baseUrl,
    password: process.env.OMNIROUTE_ADMIN_PASSWORD || defaultAdminPassword
  };
}

export function providerKey(value: string = ""): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function loginAdmin(): Promise<string> {
  const { baseUrl, password } = getAdminConfig();
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Omniroute admin login ${response.status}: ${text}`);       
  }
  const setCookie = response.headers.get("set-cookie") || "";
  const authCookie = setCookie.split(";")[0];
  if (!authCookie) throw new Error("Omniroute admin login nao retornou cookie.");
  
  cachedCookie = {
    cookie: authCookie,
    expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
  };
  return authCookie;
}

export async function getValidCookie(): Promise<string> {
  if (cachedCookie && cachedCookie.expiresAt > Date.now()) {
    return cachedCookie.cookie;
  }
  return await loginAdmin();
}

export async function adminFetch(path: string, options: AdminFetchOptions = {}): Promise<unknown> {
  const { baseUrl } = getAdminConfig();
  const doFetch = (cookie: string) => fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let response = await doFetch(options.cookie || await getValidCookie());

  if (response.status === 401 && !options.cookie) {
    cachedCookie = null;
    response = await doFetch(await getValidCookie());
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Omniroute admin ${path} ${response.status}: ${text}`);     
  }
  return response.json();
}

export function compactConnectionLabel(connection: OmnirouteRawConnection = {}): string {
  return connection.name || connection.email || connection.projectId || `Account #${String(connection.id || "").slice(0, 6)}`;
}

export function connectionStatus(connection: OmnirouteRawConnection = {}): string {
  const testStatus = String(connection.testStatus || connection.status || "").toLowerCase();
  if (connection.error || testStatus.includes("error") || testStatus.includes("fail")) return "error";
  if (connection.isActive === false) return "inactive";
  if (connection.isActive === true || ["active", "connected", "healthy", "ok"].includes(testStatus)) return "connected";
  return "unknown";
}

export function safeConnection(connection: OmnirouteRawConnection = {}, usageSummary: AccountLimit | null = null, health: OmnirouteRawProviderHealth | null = null): SafeConnection {
  const status = connectionStatus(connection);
  return {
    id: connection.id,
    provider: connection.provider,
    authType: connection.authType,
    name: compactConnectionLabel(connection),
    compactLabel: compactConnectionLabel(connection),
    email: connection.email || "",
    projectId: connection.projectId || "",
    priority: connection.priority,
    isActive: connection.isActive,
    active: connection.isActive === true,
    connected: status === "connected",
    error: status === "error",
    status,
    testStatus: connection.testStatus,
    expiresAt: connection.expiresAt,
    tokenExpiresAt: connection.tokenExpiresAt,
    lastTested: connection.lastTested,
    lastHealthCheckAt: connection.lastHealthCheckAt,
    rateLimitProtection: connection.rateLimitProtection,
    maxConcurrent: connection.maxConcurrent,
    plan: inferPlan(connection),
    accountType: inferPlan(connection),
    health,
    usageSummary
  };
}

export function inferPlan(connection: OmnirouteRawConnection = {}): string {
  const haystack = JSON.stringify({
    name: connection.name,
    email: connection.email,
    providerSpecificData: connection.providerSpecificData,
    scope: connection.scope
  }).toLowerCase();
  if (haystack.includes("business")) return "business";
  if (haystack.includes("team")) return "team";
  if (haystack.includes("enterprise")) return "enterprise";
  if (haystack.includes("pro")) return "pro";
  if (haystack.includes("free")) return "free";
  if (haystack.includes("limited")) return "free";
  return "";
}

function typeLabel(authType: string = "", provider: string = ""): string {
  const key = providerKey(provider);
  if (key.includes("search") || ["exa-search", "perplexity-web"].includes(key)) return "search";
  if (key.includes("web")) return "web-cookie";
  if (["openrouter", "pollinations", "huggingface", "kilocode", "kilo-gateway"].includes(key)) return "aggregator";
  if (["openai-compatible", "openai-compatible-api", "compatible"].includes(key) || key.includes("compatible")) return "compatible";
  if (String(authType).toLowerCase().includes("oauth")) return "oauth";
  return "api-key";
}

function providerDisplayName(provider: string = "", pricing: OmniroutePricingEntry = {}, catalog: OmnirouteCatalogEntry = {}): string {
  return pricing?.name || catalog?.provider || String(provider || "")
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : "")
    .join(" ");
}

function firstEntryByProvider(collection: Record<string, unknown> = {}, key: string = ""): unknown {
  return Object.entries(collection || {}).find(([id]) => providerKey(id) === key)?.[1];
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function pickValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function normalizeUsage(providerUsage: OmnirouteRawUsage = {}): NormalizedUsage {
  const promptTokens = pickNumber(providerUsage.promptTokens, providerUsage.prompt_tokens, providerUsage.inputTokens, providerUsage.input_tokens) || 0;
  const completionTokens = pickNumber(providerUsage.completionTokens, providerUsage.completion_tokens, providerUsage.outputTokens, providerUsage.output_tokens) || 0;
  const totalTokens = pickNumber(providerUsage.totalTokens, providerUsage.total_tokens, providerUsage.tokens, promptTokens + completionTokens);
  return {
    ...providerUsage,
    requests: pickNumber(providerUsage.requests, providerUsage.totalRequests, providerUsage.count) || 0,
    promptTokens,
    completionTokens,
    totalTokens,
    cost: pickNumber(providerUsage.cost, providerUsage.totalCost, providerUsage.estimatedCostUsd, providerUsage.estimated_cost_usd)
  };
}

function normalizeRateLimit(item: OmnirouteRawRateLimit = {}): NormalizedRateLimit {
  const used = pickNumber(item.used, item.usedTokens, item.current, item.count, item.requestsUsed, item.tokensUsed);
  const limit = pickNumber(item.limit, item.limitTokens, item.maxTokens, item.quota, item.requestsLimit, item.tokensLimit);
  const remaining = pickNumber(item.remaining, item.remainingTokens, item.requestsRemaining, item.tokensRemaining, limit !== null && used !== null ? limit - used : null);
  return {
    ...item,
    used,
    limit,
    remaining,
    resetAt: pickValue(item.resetAt, item.reset_at, item.windowResetAt, item.nextResetAt, item.resetsAt)
  };
}

function accountLimitFor(connection: OmnirouteRawConnection = {}, rateLimits: OmnirouteRawRateLimit[] = [], usage: NormalizedUsage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: null, cost: null }): AccountLimit {
  const match = rateLimits
    .map(normalizeRateLimit)
    .find((item) => item.connectionId === connection.id || item.accountId === connection.id || item.id === connection.id);
  if (!match) return {
    used: null,
    limit: null,
    remaining: null,
    resetAt: null,
    requests: usage.requests ?? null,
    totalTokens: usage.totalTokens ?? null,
    cost: usage.cost ?? null
  };
  return {
    used: match.used,
    limit: match.limit,
    remaining: match.remaining,
    resetAt: match.resetAt,
    requests: usage.requests ?? null,
    totalTokens: usage.totalTokens ?? null,
    cost: usage.cost ?? null
  };
}

function providerHealthFor(tokenHealth: OmnirouteTokenHealthResponse = {}, key: string = ""): OmnirouteRawProviderHealth | null {
  const byProviders = !Array.isArray(tokenHealth.providers) ? (tokenHealth.providers as Record<string, unknown> | undefined) ?? {} : {};
  const byByProvider = !Array.isArray(tokenHealth.byProvider) ? (tokenHealth.byProvider as Record<string, unknown> | undefined) ?? {} : {};
  return (firstEntryByProvider(byProviders, key) as OmnirouteRawProviderHealth | undefined)
    ?? (firstEntryByProvider(byByProvider, key) as OmnirouteRawProviderHealth | undefined)
    ?? (Array.isArray(tokenHealth.providers) ? (tokenHealth.providers as OmnirouteRawProviderHealth[]).find((item) => providerKey(item.provider || item.id || item.name) === key) : null)
    ?? null;
}

function aggregateUsageSummary({ usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: null, cost: null }, rateLimits = [] }: { usage?: NormalizedUsage, rateLimits?: OmnirouteRawRateLimit[] } = {}): UsageSummary {
  const normalizedLimits = rateLimits.map(normalizeRateLimit);
  const usedValues = normalizedLimits.map((item) => item.used).filter((value) => value !== null);
  const limitValues = normalizedLimits.map((item) => item.limit).filter((value) => value !== null);
  const remainingValues = normalizedLimits.map((item) => item.remaining).filter((value) => value !== null);
  const resetAt = (normalizedLimits.map((item) => item.resetAt).filter((v): v is string => typeof v === 'string').sort()[0]) ?? null;
  return {
    used: usedValues.length ? usedValues.reduce((total, value) => total + value, 0) : null,
    limit: limitValues.length ? limitValues.reduce((total, value) => total + value, 0) : null,
    remaining: remainingValues.length ? remainingValues.reduce((total, value) => total + value, 0) : null,
    resetAt,
    requests: usage.requests ?? null,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    cost: usage.cost ?? null
  };
}

function collectRateLimitEntries(rateLimits: OmnirouteRateLimitsResponse = {}): OmnirouteRawRateLimit[] {
  const entries: OmnirouteRawRateLimit[] = [];
  if (Array.isArray(rateLimits.connections)) entries.push(...rateLimits.connections);
  if (Array.isArray(rateLimits.providers)) entries.push(...rateLimits.providers);
  if (Array.isArray(rateLimits.byProvider)) {
    entries.push(...rateLimits.byProvider);
  } else if (rateLimits.byProvider && typeof rateLimits.byProvider === "object") {
    for (const [provider, value] of Object.entries(rateLimits.byProvider)) {
      entries.push({ provider, ...(value as OmnirouteRawRateLimit) });
    }
  }
  return entries;
}

function normalizeModel(model: OmnirouteRawModel = {}): NormalizedModel {
  const active = model.isActive ?? model.active ?? model.enabled;
  return {
    id: model.id,
    name: model.name || model.label || model.id || 'unknown',
    source: model.source,
    apiFormat: model.apiFormat,
    supportedEndpoints: model.supportedEndpoints || [],
    inputTokenLimit: model.inputTokenLimit,
    outputTokenLimit: model.outputTokenLimit,
    supportsThinking: model.supportsThinking,
    active: active === undefined ? null : active === true,
    status: active === false ? "inactive" : active === true ? "active" : "unknown"
  };
}

export function buildOmnirouteIntelligence({
  providers = {},
  providerModels = {},
  usage = {},
  rateLimits = {},
  tokenHealth = {},
  pricing = {},
  catalog = {},
  now = new Date().toISOString()
}: BuildIntelligenceInput = {}): OmnirouteIntelligence {
  const connections: OmnirouteRawConnection[] = providers.connections || [];
  const pricingByProvider: Record<string, OmniroutePricingEntry> = pricing || {};
  const catalogByProvider: Record<string, OmnirouteCatalogEntry> = (catalog as OmnirouteCatalogResponse).catalog || {};
  const rawUsageByProvider: Record<string, OmnirouteRawUsage> = (usage as OmnirouteUsageHistory).byProvider || {};
  const usageByProvider: Record<string, NormalizedUsage> = Object.fromEntries(
    Object.entries(rawUsageByProvider).map(([key, value]) => [providerKey(key), normalizeUsage(value)])
  );
  const usageByModel: Record<string, OmnirouteRawUsage> = (usage as OmnirouteUsageHistory).byModel || {};
  const rateConnections = collectRateLimitEntries(rateLimits as OmnirouteRateLimitsResponse);
  const modelsByProvider: Record<string, OmnirouteRawModel[]> = (providerModels as OmnirouteProviderModelsResponse).models || {};

  const providersMap: Record<string, NormalizedProvider> = {};
  const allProviderKeys = new Set([
    ...Object.keys(pricingByProvider),
    ...Object.keys(catalogByProvider),
    ...Object.keys(modelsByProvider),
    ...connections.map((item) => item.provider),
    ...Object.keys(rawUsageByProvider),
    ...rateConnections.map((item) => item.provider)
  ].filter(Boolean).map((k) => providerKey(k as string)));

  for (const key of allProviderKeys) {
    const rawConnections = connections.filter((item) => providerKey(item.provider) === key);
    const providerRateLimits = rateConnections.filter((item) => providerKey(item.provider) === key).map(normalizeRateLimit);
    const pricingEntry: OmniroutePricingEntry = (firstEntryByProvider(pricingByProvider as Record<string, unknown>, key) as OmniroutePricingEntry) || {};
    const catalogEntry: OmnirouteCatalogEntry = (firstEntryByProvider(catalogByProvider as Record<string, unknown>, key) as OmnirouteCatalogEntry) || {};
    const modelsEntry: OmnirouteRawModel[] = (firstEntryByProvider(modelsByProvider as Record<string, unknown>, key) as OmnirouteRawModel[]) || [];
    const firstConnection: OmnirouteRawConnection = rawConnections[0] || {};
    const authType = firstConnection.authType || pricingEntry.authType || catalogEntry.authType || "";
    const normalizedUsageEntry: NormalizedUsage = usageByProvider[key] || normalizeUsage({});
    const providerHealth = providerHealthFor(tokenHealth as OmnirouteTokenHealthResponse, key);
    const providerUsageSummary = aggregateUsageSummary({ usage: normalizedUsageEntry, rateLimits: rateConnections.filter((item) => providerKey(item.provider) === key) });
    const providerConnections = rawConnections.map((connection) =>
      safeConnection(connection, accountLimitFor(connection, providerRateLimits as OmnirouteRawRateLimit[], normalizedUsageEntry), providerHealth)
    );
    const normalizedModels = modelsEntry.map(normalizeModel);
    const activeModelCount = normalizedModels.filter((model) => model.active === true).length;
    const inactiveModelCount = normalizedModels.filter((model) => model.active === false).length;
    const connected = providerConnections.some((item) => item.connected);
    const error = providerConnections.some((item) => item.error) || String(providerHealth?.status || "").toLowerCase().includes("error");
    const active = providerConnections.some((item) => item.isActive) || catalogEntry.active === true;

    providersMap[key] = {
      key,
      id: key,
      canonicalId: key,
      name: providerDisplayName(key, pricingEntry, catalogEntry),
      displayName: providerDisplayName(key, pricingEntry, catalogEntry),
      authType: authType || "",
      type: typeLabel(authType, key),
      active,
      status: active ? "active" : "inactive",
      connected,
      error,
      connections: providerConnections,
      accounts: providerConnections,
      rateLimits: providerRateLimits as NormalizedRateLimit[],
      usage: normalizedUsageEntry,
      usageSummary: providerUsageSummary,
      health: providerHealth,
      tokenHealth: providerHealth,
      modelCount: Number(pricingEntry.modelCount || (catalogEntry.models as unknown[] | undefined)?.length || modelsEntry.length || 0),
      modelTotals: {
        total: normalizedModels.length,
        active: activeModelCount,
        inactive: inactiveModelCount
      },
      models: normalizedModels
    };
  }

  const usageRecord = usage as OmnirouteUsageHistory;
  return {
    ok: true,
    fetchedAt: now,
    tokenHealth: Object.keys(tokenHealth || {}).length ? tokenHealth as OmnirouteTokenHealthResponse : null,
    totals: Object.keys(usageRecord || {}).length ? {
      requests: usageRecord.totalRequests,
      promptTokens: usageRecord.totalPromptTokens,
      completionTokens: usageRecord.totalCompletionTokens,
      cost: usageRecord.totalCost
    } : null,
    providers: providersMap,
    usageByModel
  };
}

export async function fetchOmnirouteIntelligence() {
  const cookie = await getValidCookie();
  const [providers, providerModels, usage, rateLimits, tokenHealth, pricing, catalog] = await Promise.allSettled([
    adminFetch("/api/providers", { cookie }),
    adminFetch("/api/provider-models", { cookie }),
    adminFetch("/api/usage/history", { cookie }),
    adminFetch("/api/rate-limits", { cookie }),
    adminFetch("/api/token-health", { cookie }),
    adminFetch("/api/pricing/models", { cookie }),
    adminFetch("/api/models/catalog", { cookie })
  ]);

  return buildOmnirouteIntelligence({
    providers: providers.status === "fulfilled" ? providers.value as OmnirouteProvidersResponse : {},
    providerModels: providerModels.status === "fulfilled" ? providerModels.value as OmnirouteProviderModelsResponse : {},
    usage: usage.status === "fulfilled" ? usage.value as OmnirouteUsageHistory : {},
    rateLimits: rateLimits.status === "fulfilled" ? rateLimits.value as OmnirouteRateLimitsResponse : {},
    tokenHealth: tokenHealth.status === "fulfilled" ? tokenHealth.value as OmnirouteTokenHealthResponse : {},
    pricing: pricing.status === "fulfilled" ? pricing.value as Record<string, OmniroutePricingEntry> : {},
    catalog: catalog.status === "fulfilled" ? catalog.value as OmnirouteCatalogResponse : {}
  });
}
