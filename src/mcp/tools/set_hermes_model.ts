import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:/@+-]+$/;

export const SetHermesModelSchema = z.object({
  model_id: z.string().min(1).regex(
    SAFE_MODEL_ID_RE,
    'invalid model_id: only model-id characters are allowed',
  ),
});

export async function setHermesModelTool(raw: unknown): Promise<string> {
  const { model_id } = SetHermesModelSchema.parse(raw);
  const configPath = join(homedir(), '.hermes', 'config.yaml');

  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch {
    return JSON.stringify({ error: `Hermes config not found at ${configPath}` });
  }

  // Sprint 3.3 (D-H2.066, F-SEC-5): write with mode 0o600 so the Hermes
  // model config (which the LLM-callable tool can rewrite) is operator-only.
  // Mode is no-op on Windows (umask) but matters on Linux multi-user shells.
  // Replace top-level `model: <value>` line (simple or nested first line only).
  const updated = content.replace(/^model:.*$/m, `model: '${model_id}'`);
  if (updated === content) {
    // model key not found — prepend it
    writeFileSync(configPath, `model: '${model_id}'\n${content}`, { encoding: 'utf-8', mode: 0o600 });
  } else {
    writeFileSync(configPath, updated, { encoding: 'utf-8', mode: 0o600 });
  }

  return JSON.stringify({
    model_id,
    config_path: configPath,
    message: 'Modelo do Hermes atualizado. A mudança entra em vigor na próxima sessão (reinicie o gateway se necessário).',
  });
}
