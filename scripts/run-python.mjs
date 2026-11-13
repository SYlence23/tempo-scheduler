import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pythonExecutable } from './python.mjs';

const role = process.argv[2];
if (!['worker', 'balancer', 'autoscaler', 'supervisor'].includes(role)) throw new Error('Unknown Python service');
const child = spawn(pythonExecutable(), ['-m', `backend.python.${role}`], {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
