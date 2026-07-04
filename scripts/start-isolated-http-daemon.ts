import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startHttpMcpServer } from '../src/mcp/http-server.js';

const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--');

function argValue(name: string): string | undefined {
  const index = cliArgs.indexOf(name);
  if (index < 0) return undefined;
  const value = cliArgs[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const port = Number.parseInt(
  argValue('--port') ?? process.env.OMNIFORGE_DAEMON_PORT ?? '20139',
  10,
);
const dataDir = path.resolve(
  argValue('--data-dir') ?? process.env.OMNIFORGE_ISOLATED_DATA_DIR ?? 'tmp/isolated-daemon-data',
);

if (!Number.isFinite(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid --port: ${String(port)}`);
}

mkdirSync(dataDir, { recursive: true });
const shutdown = await startHttpMcpServer(dataDir, port);

process.stderr.write(`[isolated-daemon] listening on http://127.0.0.1:${port}\n`);
process.stderr.write(`[isolated-daemon] data dir: ${dataDir}\n`);

async function stop() {
  await shutdown();
  process.exit(0);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

await new Promise<never>(() => {});
