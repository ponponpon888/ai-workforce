#!/usr/bin/env node
// Read-only literal checks. This is not a runtime safety assessment.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function readWithin(root, target) {
  if (typeof target !== 'string' || !target || target.includes('\\') || target.includes(':') || isAbsolute(target) || target.split('/').includes('..')) throw Error('invalid-target');
  const path = realpathSync(resolve(root, target));
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error('outside-root');
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('not-small-regular-file');
  return readFileSync(path, 'utf8');
}
function report(results, records = []) {
  const counts = { pass: 0, violation: 0, unknown: 0 };
  for (const r of results) counts[r.status]++;
  return { schema_version: 1, scope: 'static-literal-checks', counts,
    uncheckable_records: records.filter(r => r.checkable === false).length,
    results, exit_code: counts.violation ? 1 : counts.unknown ? 2 : 0 };
}
export function lint(root = defaultRoot) {
  let index;
  try {
    root = realpathSync(root);
    index = JSON.parse(readWithin(root, 'data/pitfalls.index.json'));
    if (!object(index) || index.schema_version !== 1 || !Array.isArray(index.checks) || !index.checks.length || !Array.isArray(index.records)) throw Error();
    const ids = new Set();
    for (const r of index.records) {
      if (!object(r) || typeof r.id !== 'string' || ids.has(r.id) || typeof r.checkable !== 'boolean') throw Error();
      ids.add(r.id);
    }
    const checkIds = new Set();
    for (const c of index.checks) {
      if (!object(c) || typeof c.id !== 'string' || checkIds.has(c.id) || !index.records.some(r => r.id === c.id && r.checkable)) throw Error();
      checkIds.add(c.id);
    }
    if (index.records.some(r => r.checkable && !checkIds.has(r.id))) throw Error();
  } catch {
    return report([{ id: 'index', status: 'unknown', reason: 'unreadable-or-invalid-index' }]);
  }
  return report(index.checks.map(c => {
    const record = index.records.find(r => r.id === c.id);
    const result = { id: c.id, target: c.target, severity: c.severity, confidence: record.confidence, stale_risk: record.stale_risk };
    try {
      if (typeof c.pattern !== 'string' || !c.pattern || !['present', 'absent'].includes(c.expect)) throw Error('invalid-check');
      if (!['file-content', 'settings-json'].includes(c.kind)) throw Error('unsupported-kind');
      const text = readWithin(root, c.target);
      let strings = [text];
      if (c.kind === 'settings-json') {
        let settings;
        try { settings = JSON.parse(text); } catch { throw Error('invalid-settings-json'); }
        if (!object(settings) || !object(settings.permissions)) throw Error('invalid-permissions');
        strings = [];
        for (const key of ['allow', 'ask', 'deny']) {
          const rules = settings.permissions[key];
          if (rules === undefined) continue;
          if (!Array.isArray(rules) || rules.some(r => typeof r !== 'string')) throw Error('invalid-permission-rules');
          strings.push(...rules);
        }
      }
      const found = strings.some(s => s.includes(c.pattern));
      const pass = found === (c.expect === 'present');
      return { ...result, status: pass ? 'pass' : 'violation', reason: pass ? 'expectation-met' : 'expectation-not-met', message: c.message };
    } catch (e) {
      const reasons = ['invalid-check', 'unsupported-kind', 'invalid-target', 'outside-root', 'not-small-regular-file', 'invalid-settings-json', 'invalid-permissions', 'invalid-permission-rules'];
      return { ...result, status: 'unknown', reason: reasons.includes(e.message) ? e.message : 'target-unreadable' };
    }
  }), index.records);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let root = defaultRoot, json = false;
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') json = true;
      else if (args[i] === '--root' && args[i + 1] && !args[i + 1].startsWith('--')) root = resolve(args[++i]);
      else throw Error();
    }
    const out = lint(root);
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const r of out.results) console.log(`${r.status}: ${JSON.stringify(r.id)} (${r.reason})`);
      console.log(`Static checks only: ${out.counts.pass} pass, ${out.counts.violation} violation, ${out.counts.unknown} unknown; ${out.uncheckable_records} records not checkable.`);
    }
    process.exitCode = out.exit_code;
  } catch {
    console.error('Usage: node kit/scripts/lint-pitfalls.mjs [--root <repository>] [--json]');
    process.exitCode = 2;
  }
}
