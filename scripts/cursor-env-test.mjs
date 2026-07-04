// Diagnostic harness for the cursor hang investigation (2026-05-01).
// Tests whether cursor's inner index.js requires CURSOR_INVOKED_AS /
// NODE_COMPILE_CACHE env vars (set by the .ps1 launcher we bypass when
// resolveSpawnTarget unwraps cursor-agent.cmd → node.exe + index.js).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = join(tmpdir(), 'omni-spawn-debug', 'cursor-env-test');
mkdirSync(cwd, { recursive: true });

const env = { ...process.env, NO_COLOR: '1' };
delete env.CLAUDECODE;
delete env.OMNIFORGE_DAEMON_CHILD;

// Set the two env vars the .ps1 shim normally sets:
env.CURSOR_INVOKED_AS = 'cursor-agent.cmd';
env.NODE_COMPILE_CACHE = `${process.env.LOCALAPPDATA}\\cursor-compile-cache`;

const node = `${process.env.LOCALAPPDATA}\\cursor-agent\\versions\\2026.04.30-4edb302\\node.exe`;
const script = `${process.env.LOCALAPPDATA}\\cursor-agent\\versions\\2026.04.30-4edb302\\index.js`;

const prompt = process.argv[2] === 'complex'
  ? 'Test prompt for cursor. Use the shell tool to write the literal text "HELLO_CURSOR_VIA_SPAWN" to ./out.txt and then exit.'
  : 'Say HELLO and exit';
console.log(`prompt: ${prompt}`);

const stdinMode = process.argv[3] === 'ignore' ? 'ignore' : 'pipe';
console.log(`stdinMode: ${stdinMode}`);
const child = spawn(node, [script, '-p', '--output-format', 'text', '--trust', '--force', prompt], {
  cwd, env, shell: false, stdio: [stdinMode, 'pipe', 'pipe'],
});

let stdout = '', stderr = '';
const t0 = Date.now();
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });
child.on('close', (code) => {
  console.log(`EXIT ${code} after ${Date.now() - t0}ms`);
  console.log('STDOUT:', stdout);
  console.log('STDERR:', stderr);
  process.exit(code ?? 1);
});
if (stdinMode === 'pipe' && child.stdin) {
  child.stdin.end();
}
setTimeout(() => { console.error('TIMEOUT'); child.kill(); }, 60000);
