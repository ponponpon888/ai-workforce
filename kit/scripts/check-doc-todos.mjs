#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Markers must begin a prose line (optionally a heading/list/task item).
// Fenced and four-space/tab-indented code examples are excluded.
export function findTodos(text) {
  const findings = [];
  let fence = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = open[1]; continue; }
    if (/^(?: {4}|\t)/.test(line)) continue;
    if (/^ {0,3}(?:#{1,6}\s+)?(?:(?:[-+*]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?TODO(?:\([^()\r\n]+\))?:/.test(line)) {
      findings.push({ line: i + 1, text: line.trim() });
    }
  }
  return findings;
}
export function checkDocs(root) {
  const files = ['README.md', 'README.en.md'];
  function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  }
  walk('docs');
  return files.sort().flatMap(path => findTodos(readFileSync(join(root, path), 'utf8')).map(f => ({ path: path.split('\\').join('/'), ...f })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('This command takes no arguments.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const findings = checkDocs(root);
    for (const f of findings) console.log(`${JSON.stringify(f.path)}:${f.line}: ${JSON.stringify(f.text)}`);
    console.log(`${findings.length} prose TODO marker(s).`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Cannot check docs: invalid arguments or unreadable input.');
    process.exitCode = 2;
  }
}
