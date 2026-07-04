import { z } from 'zod';
import { openSync, readSync, closeSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ReadFileSchema = z.object({
  path: z.string().min(1),
  max_bytes: z.number().int().positive().optional().default(200_000),
});

const DENIED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'daemon-token.txt',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
]);

function allowedRoots(): string[] {
  const extras = (process.env.OMNIFORGE_READ_FILE_ALLOWLIST ?? '')
    .split(';')
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter(Boolean);
  return [process.cwd(), ...extras].map((root) => path.resolve(root));
}

function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function isDeniedSecretPath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (DENIED_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  return /\.(pem|key|p12|pfx)$/i.test(base);
}

export function readFileTool(raw: unknown): string {
  const { path: rawPath, max_bytes } = ReadFileSchema.parse(raw);

  const filePath = rawPath.startsWith('~/')
    ? rawPath.replace('~', homedir())
    : path.resolve(rawPath);

  // 1. Validação sintática preliminar para evitar vazamentos de existência fora do sandbox
  const roots = allowedRoots();
  const isSyntacticallySafe = roots.some((root) => {
    const rel = path.relative(root, filePath);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  });
  if (!isSyntacticallySafe) {
    return JSON.stringify({
      error: `Access denied: file is outside allowed roots. Configure OMNIFORGE_READ_FILE_ALLOWLIST to permit additional directories.`,
    });
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return JSON.stringify({ error: `File not found: ${filePath}` });
  }

  if (!stat.isFile()) {
    return JSON.stringify({ error: `Not a file: ${filePath}` });
  }

  const realFilePath = realpathSync(filePath);
  if (isDeniedSecretPath(realFilePath)) {
    return JSON.stringify({ error: `Access denied for secret-like file: ${filePath}` });
  }

  // 2. Validação física pós-resolução de symlinks
  const realRoots = roots.map((root) => {
    try { return realpathSync(root); } catch { return path.resolve(root); }
  });
  if (!realRoots.some((root) => isInside(realFilePath, root))) {
    return JSON.stringify({
      error: `Access denied: file is outside allowed roots. Configure OMNIFORGE_READ_FILE_ALLOWLIST to permit additional directories.`,
    });
  }

  const size = stat.size;
  let content: string;
  let truncated = false;

  if (size > max_bytes) {
    const buf = Buffer.alloc(max_bytes);
    const fd = openSync(filePath, 'r');
    readSync(fd, buf, 0, max_bytes, 0);
    closeSync(fd);
    content = buf.toString('utf8');
    truncated = true;
  } else {
    content = readFileSync(filePath, 'utf8');
  }

  return JSON.stringify({
    path: filePath,
    size_bytes: size,
    truncated,
    ...(truncated && { max_bytes }),
      content,
  });
}
