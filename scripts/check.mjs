import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['node_modules','tools','.runtime','.git']);
const sourceExtensions = new Set(['.js','.mjs','.css','.html','.sql','.yml','.ps1','.conf']);
let count = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path); continue; }
    if (!sourceExtensions.has(extname(path))) continue;
    const source = await readFile(path,'utf8');
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (line.startsWith('/' + '/') || line.includes('/' + '*') || line.includes('<' + '!--') || line.startsWith('-' + '- ') || ((path.endsWith('.ps1') || path.endsWith('.yml') || path.endsWith('.conf')) && line.startsWith('#'))) throw new Error(`Source comment: ${path}:${index+1}`);
    }
    if (/\.m?js$/.test(path)) {
      const check = spawnSync(process.execPath,['--check',path],{encoding:'utf8',windowsHide:true});
      if (check.status !== 0) throw new Error(check.stderr || `Syntax check failed: ${path}`);
    }
    count++;
  }
}
await inspect(root);
console.log(`Verified ${count} source files: valid JavaScript syntax, no source comments.`);
