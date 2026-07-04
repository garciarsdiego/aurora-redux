/**
 * Types for the Omniroute admin bridge.
 *
 * These interfaces model the shapes returned by the Omniroute admin REST API
 * and the intermediate normalized objects produced inside admin.ts.
 * All properties are `readonly` — consumers must not mutate API responses.
 */

// ---------------------------------------------------------------------------
// Raw API response shapes (as returned by the Omniroute admin endpoints)
// ---------------------------------------------------------------------------

/** Raw connection record from GET /api/providers */
export interface OmnirouteRawConnection {
  readonly id?: string | number;
  readonly provider?: string;
  readonly authType?: string;
  readonly name?: string;
  readonly email?: string;
  readonly projectId?: string;
  readonly priority?: number;
  readonly isActive?: boolean;
  readonly testStatus?: string;
  readonly status?: string;
  readonly error?: string | boolean;
  readonly expiresAt?: string | null;
  readonly tokenExpiresAt?: string | null;
  readonly lastTested?: string | null;
  readonly lastHealthCheckAt?: string | null;
  readonly rateLimitProtection?: boolean | null;
  readonly maxConcurrent?: number | null;
  readonly providerSpecificData?: Record<string, unknown>;
  readonly scope?: string | string[];
  [key: string]: unknown;
}

/** Raw provider-models entry from GET /api/provider-models */
export interface OmnirouteRawModel {
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly apiFormat?: string;
  readonly supportedEndpoints?: string[];
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly supportsThinking?: boolean;
  readonly isActive?: boolean;
  readonly active?: boolean;
  readonly enabled?: boolean;
  [key: string]: unknown;
}

/** Raw rate-limit entry (used in /api/rate-limits arrays) */
export interface OmnirouteRawRateLimit {
  readonly provider?: string;
  readonly connectionId?: string | number;
  readonly accountId?: string | number;
  readonly id?: string | number;
  readonly used?: number | null;
  readonly usedTokens?: number | null;
  readonly current?: number | null;
  readonly count?: number | null;
  readonly requestsUsed?: number | null;
  readonly tokensUsed?: number | null;
  readonly limit?: number | null;
  readonly limitTokens?: number | null;
  readonly maxTokens?: number | null;
  readonly quota?: number | null;
  readonly requestsLimit?: number | null;
  readonly tokensLimit?: number | null;
  readonly remaining?: number | null;
  readonly remainingTokens?: number | null;
  readonly requestsRemaining?: number | null;
  readonly tokensRemaining?: number | null;
  readonly resetAt?: string | null;
  readonly reset_at?: string | null;
  readonly windowResetAt?: string | null;
  readonly nextResetAt?: string | null;
  readonly resetsAt?: string | null;
  [key: string]: unknown;
}

/** Raw provider-level health entry from GET /api/token-health */
export interface OmnirouteRawProviderHealth {
  readonly provider?: string;
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
  readonly error?: string | null;
  [key: string]: unknown;
}

/** Raw usage record keyed by provider or model */
export interface OmnirouteRawUsage {
  readonly promptTokens?: number;
  readonly prompt_tokens?: number;
  readonly inputTokens?: number;
  readonly input_tokens?: number;
  readonly completionTokens?: number;
  readonly completion_tokens?: number;
  readonly outputTokens?: number;
  readonly output_tokens?: number;
  readonly totalTokens?: number;
  readonly total_tokens?: number;
  readonly tokens?: number;
  readonly requests?: number;
  readonly totalRequests?: number;
  readonly count?: number;
  readonly cost?: number;
  readonly totalCost?: number;
  readonly estimatedCostUsd?: number;
  readonly estimated_cost_usd?: number;
  [key: string]: unknown;
}

/** Wrapper returned by GET /api/usage/history */
export interface OmnirouteUsageHistory {
  readonly byProvider?: Record<string, OmnirouteRawUsage>;
  readonly byModel?: Record<string, OmnirouteRawUsage>;
  readonly totalRequests?: number;
  readonly totalPromptTokens?: number;
  readonly totalCompletionTokens?: number;
  readonly totalCost?: number;
  [key: string]: unknown;
}

/** Wrapper returned by GET /api/providers */
export interface OmnirouteProvidersResponse {
  readonly connections?: OmnirouteRawConnection[];
  [key: string]: unknown;
}

/** Wrapper returned by GET /api/provider-models */
export interface OmnirouteProviderModelsResponse {
  /** Keyed by provider id → array of models */
  readonly models?: Record<string, OmnirouteRawModel[]>;
  [key: string]: unknown;
}

/** Wrapper returned by GET /api/rate-limits */
export interface OmnirouteRateLimitsResponse {
  readonly connections?: OmnirouteRawRateLimit[];
  readonly providers?: OmnirouteRawRateLimit[];
  readonly byProvider?: Record<string, OmnirouteRawRateLimit> | OmnirouteRawRateLimit[];
  [key: string]: unknown;
}

/** Wrapper returned by GET /api/token-health */
export interface OmnirouteTokenHealthResponse {
  readonly providers?: Record<string, OmnirouteRawProviderHealth> | OmnirouteRawProviderHealth[];
  readonly byProvider?: Record<string, OmnirouteRawProviderHealth> | OmnirouteRawProviderHealth[];
  readonly status?: string;
  [key: string]: unknown;
}

/** Entry from GET /api/pricing/models */
export interface OmniroutePricingEntry {
  readonly name?: string;
  readonly authType?: string;
  readonly modelCount?: number;
  [key: string]: unknown;
}

/** Entry from GET /api/models/catalog */
export interface OmnirouteCatalogEntry {
  readonly provider?: string;
  readonly authType?: string;
  readonly active?: boolean;
  readonly models?: unknown[];
  [key: string]: unknown;
}

/** Wrapper returned by GET /api/models/catalog */
export interface OmnirouteCatalogResponse {
  readonly catalog?: Record<string, OmnirouteCatalogEntry>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalized / processed shapes produced by admin.ts helper functions
// ---------------------------------------------------------------------------

/** Normalized usage object (output of normalizeUsage) */
export interface NormalizedUsage {
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number | null;
  readonly cost: number | null;
  [key: string]: unknown;
}

/** Normalized rate-limit entry (output of normalizeRateLimit) */
export interface NormalizedRateLimit {
  readonly used: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: unknown;
  [key: string]: unknown;
}

/** Aggregated usage summary across all rate-limit entries for a provider */
export interface UsageSummary {
  readonly used: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
  readonly requests: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly cost: number | null;
}

/** Per-account limit object returned by accountLimitFor */
export interface AccountLimit {
  readonly used: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: unknown;
  readonly requests: number | null;
  readonly totalTokens: number | null;
  readonly cost: number | null;
}

/** Normalized model (output of normalizeModel) */
export interface NormalizedModel {
  readonly id: string | undefined;
  readonly name: string;
  readonly source: string | undefined;
  readonly apiFormat: string | undefined;
  readonly supportedEndpoints: string[];
  readonly inputTokenLimit: number | undefined;
  readonly outputTokenLimit: number | undefined;
  readonly supportsThinking: boolean | undefined;
  readonly active: boolean | null;
  readonly status: "active" | "inactive" | "unknown";
}

/** Safe / normalized connection object (output of safeConnection) */
export interface SafeConnection {
  readonly id: string | number | undefined;
  readonly provider: string | undefined;
  readonly authType: string | undefined;
  readonly name: string;
  readonly compactLabel: string;
  readonly email: string;
  readonly projectId: string;
  readonly priority: number | undefined;
  readonly isActive: boolean | undefined;
  readonly active: boolean;
  readonly connected: boolean;
  readonly error: boolean;
  readonly status: string;
  readonly testStatus: string | undefined;
  readonly expiresAt: string | null | undefined;
  readonly tokenExpiresAt: string | null | undefined;
  readonly lastTested: string | null | undefined;
  readonly lastHealthCheckAt: string | null | undefined;
  readonly rateLimitProtection: boolean | null | undefined;
  readonly maxConcurrent: number | null | undefined;
  readonly plan: string;
  readonly accountType: string;
  readonly health: OmnirouteRawProviderHealth | null;
  readonly usageSummary: AccountLimit | null;
}

/** Normalized provider entry inside the providersMap */
export interface NormalizedProvider {
  readonly key: string;
  readonly id: string;
  readonly canonicalId: string;
  readonly name: string;
  readonly displayName: string;
  readonly authType: string;
  readonly type: string;
  readonly active: boolean;
  readonly status: "active" | "inactive";
  readonly connected: boolean;
  readonly error: boolean;
  readonly connections: SafeConnection[];
  readonly accounts: SafeConnection[];
  readonly rateLimits: NormalizedRateLimit[];
  readonly usage: NormalizedUsage;
  readonly usageSummary: UsageSummary;
  readonly health: OmnirouteRawProviderHealth | null;
  readonly tokenHealth: OmnirouteRawProviderHealth | null;
  readonly modelCount: number;
  readonly modelTotals: {
    readonly total: number;
    readonly active: number;
    readonly inactive: number;
  };
  readonly models: NormalizedModel[];
}

/** Return type of buildOmnirouteIntelligence / fetchOmnirouteIntelligence */
export interface OmnirouteIntelligence {
  readonly ok: boolean;
  readonly fetchedAt: string;
  readonly tokenHealth: OmnirouteTokenHealthResponse | null;
  readonly totals: {
    readonly requests: number | undefined;
    readonly promptTokens: number | undefined;
    readonly completionTokens: number | undefined;
    readonly cost: number | undefined;
  } | null;
  readonly providers: Record<string, NormalizedProvider>;
  readonly usageByModel: Record<string, OmnirouteRawUsage>;
}

/** Options accepted by adminFetch */
export interface AdminFetchOptions {
  readonly cookie?: string;
  readonly method?: string;
  readonly body?: Record<string, unknown>;
}

/** Input bag for buildOmnirouteIntelligence */
export interface BuildIntelligenceInput {
  readonly providers?: OmnirouteProvidersResponse;
  readonly providerModels?: OmnirouteProviderModelsResponse;
  readonly usage?: OmnirouteUsageHistory;
  readonly rateLimits?: OmnirouteRateLimitsResponse;
  readonly tokenHealth?: OmnirouteTokenHealthResponse;
  readonly pricing?: Record<string, OmniroutePricingEntry>;
  readonly catalog?: OmnirouteCatalogResponse;
  readonly now?: string;
}
