export type ModelCapabilities = {
  attachment: boolean;
  reasoning: boolean;
  structured_output: boolean;
  temperature: boolean;
  thinking: boolean;
  tool_calling: boolean;
  vision: boolean;
};

export type ModelPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
};

export type NormalizedModel = {
  id: string;
  label: string;
  provider: string;
  contextLength: number;
  capabilities: ModelCapabilities;
  capabilityTags: string[];
  pricing: ModelPricing;
  pricingKnown: boolean;
  free: boolean;
  raw: unknown;
};

export type ModelGroup = {
  provider: string;
  models: NormalizedModel[];
};

export type IntentKind = 'vision' | 'attachment' | 'structured' | 'reasoning' | 'quick';

export type IntentInference = {
  kind: IntentKind;
  requiresVision: boolean;
  requiresAttachment: boolean;
  wantsStructuredOutput: boolean;
  wantsDeepReasoning: boolean;
  isQuick: boolean;
};

export type ScoredModel = {
  model: NormalizedModel;
  score: number;
  reasons: string[];
};

export type ModelChoiceResult = {
  model: NormalizedModel | null;
  intent: IntentInference;
  changed: boolean;
  score: number;
  reasons: string[];
  ranked: ScoredModel[];
};

type RawModel = Record<string, unknown>;
type CapabilityKey = keyof ModelCapabilities;

const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  nvidia: 'NVIDIA',
  groq: 'Groq',
  claude: 'Claude',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  gemini: 'Gemini',
  google: 'Google',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  perplexity: 'Perplexity',
  'perplexity web': 'Perplexity Web',
  'ollama cloud': 'Ollama Cloud',
};

const CAPABILITY_KEYS: CapabilityKey[] = [
  'attachment',
  'reasoning',
  'structured_output',
  'temperature',
  'thinking',
  'tool_calling',
  'vision',
];

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  attachment: 'Anexo',
  reasoning: 'Raciocinio',
  structured_output: 'JSON',
  temperature: 'Temperatura',
  thinking: 'Thinking',
  tool_calling: 'Ferramentas',
  vision: 'Visao',
};

const CAPABILITY_TAG_ORDER: CapabilityKey[] = [
  'vision',
  'attachment',
  'tool_calling',
  'reasoning',
  'thinking',
  'structured_output',
  'temperature',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readString(model: RawModel, keys: string[]): string {
  for (const key of keys) {
    const value = model[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return '';
}

export function normalizeProviderName(value = ''): string {
  const lower = String(value).trim().toLowerCase();
  const known = KNOWN_PROVIDER_NAMES[lower];
  if (known) return known;

  return (
    String(value)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim() || 'Outros'
  );
}

export function inferProvider(model: unknown = {}): string {
  const raw = asRecord(model) ?? {};
  const explicit = raw.owned_by ?? raw.ownedBy ?? raw.provider;
  if (explicit) return normalizeProviderName(String(explicit));

  const id = readString(raw, ['id', 'name']);
  if (id.includes('/')) return normalizeProviderName(id.split('/')[0] ?? '');
  if (id.includes(':')) return normalizeProviderName(id.split(':')[0] ?? '');
  if (id.includes('-')) return normalizeProviderName(id.split('-')[0] ?? '');
  return 'Outros';
}

export function normalizeCapabilities(value: unknown): ModelCapabilities {
  const normalized = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, false]),
  ) as ModelCapabilities;

  if (!value) return normalized;

  if (Array.isArray(value)) {
    for (const item of value) {
      const key = String(item).trim() as CapabilityKey;
      if (key in normalized) normalized[key] = true;
    }
    return normalized;
  }

  const record = asRecord(value);
  if (record) {
    for (const key of CAPABILITY_KEYS) {
      normalized[key] = record[key] === true;
    }
  }

  return normalized;
}

export function normalizeModel(model: unknown = {}): NormalizedModel {
  const raw = asRecord(model) ?? {};
  const id = readString(raw, ['id', 'name']).trim();
  const label = readString(raw, ['name', 'id']).trim();
  const capabilities = normalizeCapabilities(raw.capabilities);
  const capabilityTags = CAPABILITY_TAG_ORDER
    .filter((key) => capabilities[key])
    .map((key) => CAPABILITY_LABELS[key]);
  const rawCost = asRecord(raw.cost) ?? asRecord(raw.pricing) ?? {};
  const rawCache = asRecord(rawCost.cache) ?? {};
  const pricingKnown = Boolean(raw.cost || raw.pricing);
  const pricing: ModelPricing = {
    inputPerMillion: numberValue(rawCost.input ?? rawCost.prompt ?? rawCost.input_per_million),
    outputPerMillion: numberValue(rawCost.output ?? rawCost.completion ?? rawCost.output_per_million),
    cacheReadPerMillion: numberValue(rawCache.read ?? rawCost.cache_read),
    cacheWritePerMillion: numberValue(rawCache.write ?? rawCost.cache_write),
  };

  return {
    id,
    label,
    provider: inferProvider(raw),
    contextLength: numberValue(raw.context_length ?? raw.contextLength ?? raw.context),
    capabilities,
    capabilityTags,
    pricing,
    pricingKnown,
    free: pricingKnown && pricing.inputPerMillion === 0 && pricing.outputPerMillion === 0,
    raw: model,
  };
}

export function groupModels(rawModels: unknown[] = []): { groups: ModelGroup[]; models: NormalizedModel[] } {
  const seen = new Set<string>();
  const models = rawModels
    .map((model) => normalizeModel(model))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });

  const groupMap = new Map<string, NormalizedModel[]>();
  for (const model of models) {
    const providerModels = groupMap.get(model.provider) ?? [];
    providerModels.push(model);
    groupMap.set(model.provider, providerModels);
  }

  const groups = [...groupMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'pt-BR'))
    .map(([provider, providerModels]) => ({
      provider,
      models: providerModels.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
    }));

  return { groups, models };
}

export function inferIntent({
  content = '',
  referenceCount = 0,
  imageReferenceCount = 0,
}: {
  content?: string;
  referenceCount?: number;
  imageReferenceCount?: number;
} = {}): IntentInference {
  const text = String(content).toLowerCase();
  const requiresVision =
    imageReferenceCount > 0 ||
    /\b(imagem|foto|print|screenshot|visual|descreva a imagem|analise essa imagem)\b/i.test(text);
  const requiresAttachment =
    referenceCount > 0 || /\b(arquivo|csv|json|planilha|documento|anexo|referencia)\b/i.test(text);
  const wantsStructuredOutput = /\b(json|schema|tabela|csv|estrutura|campos|formato estruturado)\b/i.test(text);
  const wantsDeepReasoning =
    /\b(estrategia|analise profunda|auditoria|diagnostico|comparar|decidir|plano|arquitetura|framework|11\+1)\b/i.test(
      text,
    );
  const isQuick =
    !requiresVision &&
    !requiresAttachment &&
    !wantsStructuredOutput &&
    !wantsDeepReasoning &&
    text.length < 180;
  const kind: IntentKind = requiresVision
    ? 'vision'
    : requiresAttachment
      ? 'attachment'
      : wantsStructuredOutput
        ? 'structured'
        : wantsDeepReasoning
          ? 'reasoning'
          : 'quick';

  return {
    kind,
    requiresVision,
    requiresAttachment,
    wantsStructuredOutput,
    wantsDeepReasoning,
    isQuick,
  };
}

export function routeReasons(model: NormalizedModel, intent: IntentInference, isCurrent: boolean): string[] {
  const caps = model.capabilities;
  const reasons: string[] = [];
  if (isCurrent) reasons.push('modelo atual');
  if (intent.requiresVision && caps.vision) reasons.push('suporta visão');
  if (intent.requiresAttachment && caps.attachment) reasons.push('suporta anexos');
  if (intent.wantsStructuredOutput && caps.structured_output) reasons.push('suporta JSON estruturado');
  if (intent.wantsDeepReasoning && caps.reasoning) reasons.push('bom para raciocínio');
  if (intent.wantsDeepReasoning && caps.thinking) reasons.push('thinking ativo');
  if (caps.tool_calling) reasons.push('tool calling');
  if (model.free) reasons.push('custo catalogado zero');
  if (model.contextLength) reasons.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  return reasons.slice(0, 5);
}

export function scoreModel(model: NormalizedModel, intent: IntentInference, isCurrent: boolean): number {
  const caps = model.capabilities;
  let score = isCurrent ? 8 : 0;

  if (intent.requiresVision) score += caps.vision ? 90 : -120;
  if (intent.requiresAttachment) score += caps.attachment ? 70 : caps.vision ? 20 : -12;
  if (intent.wantsStructuredOutput) score += caps.structured_output ? 55 : -8;
  if (intent.wantsDeepReasoning) score += caps.reasoning ? 38 : 0;
  if (intent.wantsDeepReasoning) score += caps.thinking ? 18 : 0;
  if (caps.tool_calling) score += 8;
  if (caps.temperature) score += 2;

  if (intent.isQuick) {
    score += isCurrent ? 34 : 0;
    score += model.contextLength < 70_000 ? 12 : 0;
  } else {
    score += Math.min(Math.floor((model.contextLength || 0) / 50_000), 16);
  }

  return score;
}

export function chooseModelForIntent({
  models = [],
  content = '',
  referenceCount = 0,
  imageReferenceCount = 0,
  currentModelId = '',
}: {
  models?: unknown[];
  content?: string;
  referenceCount?: number;
  imageReferenceCount?: number;
  currentModelId?: string;
} = {}): ModelChoiceResult {
  const normalizedModels = models
    .map((model) => {
      const maybeModel = asRecord(model);
      return maybeModel && Array.isArray(maybeModel.capabilityTags)
        ? (model as NormalizedModel)
        : normalizeModel(model);
    })
    .filter((model) => model.id);
  const current = normalizedModels.find((model) => model.id === currentModelId);
  const intent = inferIntent({ content, referenceCount, imageReferenceCount });
  const currentScore = current ? scoreModel(current, intent, true) : -Infinity;
  const ranked = normalizedModels
    .map((model) => ({
      model,
      score: scoreModel(model, intent, model.id === currentModelId),
      reasons: routeReasons(model, intent, model.id === currentModelId),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.model.contextLength - a.model.contextLength ||
        a.model.label.localeCompare(b.model.label, 'pt-BR'),
    );

  const best = ranked[0]?.model ?? current ?? normalizedModels[0] ?? null;
  const bestScore = ranked[0]?.score ?? -Infinity;
  const selected = intent.isQuick && current && currentScore > 0 ? current : best;
  const selectedRank = ranked.find((item) => item.model.id === selected?.id);

  return {
    model: selected,
    intent,
    changed: Boolean(selected && currentModelId && selected.id !== currentModelId),
    score: selected?.id === current?.id ? currentScore : bestScore,
    reasons: selectedRank?.reasons ?? [],
    ranked: ranked.slice(0, 8).map((item) => ({
      model: item.model,
      score: item.score,
      reasons: item.reasons,
    })),
  };
}
