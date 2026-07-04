export function cliHintForModel(model: string | null | undefined): string | null {
  if (!model?.trim()) return null;
  const provider = (model.includes('/') ? model.split('/')[0] : '').toLowerCase();
  switch (provider) {
    case 'cc':
    case 'claude':
      return 'cli:claude-code';
    case 'cx':
    case 'codex':
      return 'cli:codex';
    case 'gemini-cli':
      return 'cli:gemini';
    case 'kimi':
    case 'kmc':
    case 'kmca':
    case 'kimi-coding':
      return 'cli:kimi';
    default:
      return null;
  }
}

export function isDefaultishCliHint(executorHint: string | null | undefined): boolean {
  if (!executorHint?.trim()) return true;
  const normalized = executorHint.trim().toLowerCase();
  return normalized === 'cli:claude-code' || normalized === 'cli:auto' || normalized === 'cli:default';
}

export function normalizeCliExecutorHintForModel(
  kind: string | null | undefined,
  executorHint: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (kind !== 'cli_spawn') return executorHint ?? null;
  const matchedCli = cliHintForModel(model);
  if (!matchedCli) return executorHint ?? null;
  return matchedCli;
}
