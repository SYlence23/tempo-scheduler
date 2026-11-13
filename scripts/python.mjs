import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function pythonExecutable() {
  if (process.env.TEMPO_PYTHON) return process.env.TEMPO_PYTHON;
  const local = path.resolve(import.meta.dirname, '../tools/python/python.exe');
  if (existsSync(local)) return local;
  try {
    const settings = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../.runtime/tool-paths.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (settings.pythonExe && existsSync(settings.pythonExe)) return settings.pythonExe;
  } catch {}
  return process.platform === 'win32' ? 'python' : 'python3';
}
