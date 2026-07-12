export type AutoModelTag =
  | 'auto'
  | 'auto:vision'
  | 'auto:docs'
  | 'auto:fast'
  | 'auto:strong'
  | 'auto:cheap';

export const AUTO_TAG_DEFAULTS: Record<AutoModelTag, string> = {
  auto: 'cc/claude-sonnet-4-6',
  'auto:vision': 'cc/claude-sonnet-4-6',
  'auto:docs': 'cc/claude-sonnet-4-6',
  'auto:fast': 'cc/claude-haiku-4-5-20251001',
  'auto:strong': 'cc/claude-opus-4-6',
  'auto:cheap': 'cc/claude-haiku-4-5-20251001',
};

export type AutoTagOverrides = Partial<Record<AutoModelTag, string>>;

const AUTO_TAGS = new Set<AutoModelTag>(
  Object.keys(AUTO_TAG_DEFAULTS) as AutoModelTag[],
);

export function resolveAutoTag(
  model: string | null | undefined,
  overrides: AutoTagOverrides = {},
): string {
  if (!model) return AUTO_TAG_DEFAULTS.auto;
  if (!isAutoModelTag(model)) return model;
  return overrides[model] ?? AUTO_TAG_DEFAULTS[model];
}

function isAutoModelTag(model: string): model is AutoModelTag {
  return AUTO_TAGS.has(model as AutoModelTag);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2.B — runtime cache for dashboard-managed overrides.
//
// Lets the daemon prefer a daemon_state-backed override over the static
// `OMNIFORGE_AUTO_TAG_OVERRIDES` env var without forcing every call site of
// `resolveAutoTag` to thread a DB handle. The daemon boot path hydrates the
// cache from `daemon_state['auto_tag_overrides']`; the dashboard route
// updates it when the operator saves new values. `getAutoTagOverrides()` in
// utils/config.ts now layers cache > env so a single edit takes effect for
// every subsequent Omniroute call without a restart.
// ─────────────────────────────────────────────────────────────────────────────

let runtimeOverrides: AutoTagOverrides | null = null;

export function getRuntimeAutoTagOverrides(): AutoTagOverrides | null {
  return runtimeOverrides;
}

export function setRuntimeAutoTagOverrides(overrides: AutoTagOverrides | null): void {
  runtimeOverrides = overrides;
}

export function normalizeAutoTagOverrides(input: unknown): AutoTagOverrides {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: AutoTagOverrides = {};
  for (const [tag, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isAutoModelTag(tag)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    out[tag] = trimmed;
  }
  return out;
}
