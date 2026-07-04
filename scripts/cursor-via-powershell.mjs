// Test cursor via the powershell.exe -File <ps1> path (which is what the
// .cmd shim does internally) instead of bypassing to node.exe + index.js.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cwd = join(tmpdir(), 'omni-spawn-debug', 'cursor-via-ps');
mkdirSync(cwd, { recursive: true });

const env = { ...process.env, NO_COLOR: '1' };
delete env.CLAUDECODE;
delete env.OMNIFORGE_DAEMON_CHILD;

const ps1 = `${process.env.LOCALAPPDATA}\\cursor-agent\\cursor-agent.ps1`;
const pwsh = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

if (!existsSync(ps1)) {
  console.error('ps1 not found:', ps1);
  process.exit(2);
}
if (!existsSync(pwsh)) {
  console.error('powershell.exe not found:', pwsh);
  process.exit(2);
}

const prompt = process.argv[2] === 'simple'
  ? 'Say HELLO and exit'
  : 'Test prompt for cursor. Use the shell tool to write the literal text "HELLO_CURSOR_VIA_SPAWN" to ./out.txt and then exit.';

const args = [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', ps1,
  '-p', '--output-format', 'text', '--trust', '--force',
  prompt,
];

console.log('exe:', pwsh);
console.log('args:', JSON.stringify(args));
console.log('cwd:', cwd);

const child = spawn(pwsh, args, {
  cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '', stderr = '';
const t0 = Date.now();
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });
child.on('close', (code) => {
  console.log(`EXIT ${code} after ${Date.now() - t0}ms`);
  console.log('STDOUT:', stdout.slice(-1500));
  console.log('STDERR:', stderr.slice(-1500));
  process.exit(code ?? 1);
});
setTimeout(() => { console.error('TIMEOUT'); child.kill(); }, 90000);
