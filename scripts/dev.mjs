// Starts backend (4000) and dashboard (5173) together: `npm run dev` from the repo root.
import { spawn } from 'node:child_process';
const run = (name, args) => {
  const p = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', tag); p.stderr.on('data', tag);
  p.on('exit', (c) => { console.log(`[${name}] exited ${c}`); process.exit(c ?? 0); });
  return p;
};
const procs = [run('api', ['--prefix', 'backend', 'run', 'dev']), run('web', ['--prefix', 'frontend', 'run', 'dev'])];
process.on('SIGINT', () => { procs.forEach((p) => p.kill('SIGINT')); process.exit(0); });
