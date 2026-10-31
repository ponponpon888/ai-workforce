#!/usr/bin/env node
/**
 * Compare two saved probe-guards JSON reports. This command reads only the
 * named JSON files: it does not import, launch, or otherwise invoke hooks.
 * Exit: 0 comparable reports with no result/condition difference and a fully
 * passing current report; 1 comparable reports with a difference or a current
 * failure/incomplete result; 2 invalid arguments or unusable report input.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const GUARDS = ['guard-sql', 'guard-secrets', 'guard-config', 'guard-destructive'];

function usage() {
  return 'node kit/scripts/compare-probe-reports.mjs --previous PATH --current PATH [--json]\n' +
    'Reads two saved probe reports only; it never launches hooks or payloads.\n' +
    'Exit: 0 equal, fully passing reports; 1 a valid comparison found a difference or current failure; 2 invalid input.';
}

export function validateReport(report, label) {
  if (!report || report.schemaVersion !== SCHEMA_VERSION) throw new Error(`${label} report has unsupported schemaVersion`);
  if (!Number.isInteger(report.probeDefinitionVersion)) throw new Error(`${label} report has no supported probe definition version`);
  if (typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) throw new Error(`${label} report has no valid generatedAt`);
  if (!['probe-pass', 'error', 'incomplete'].includes(report.status)) throw new Error(`${label} report has invalid aggregate status`);
  if (!Array.isArray(report.guards) || !report.guards.length) throw new Error(`${label} report has no guard list`);
  validateRuntime(report.runtime, label);
  validateIntegrity(report.integrity, label);
  const guards = new Map();
  let hasFailure = false;
  let hasUnverified = false;
  for (const guard of report.guards) {
    if (!guard || typeof guard.guard !== 'string' || !guard.guard || !['pass', 'fail', 'unverified'].includes(guard.result) || !Array.isArray(guard.probes) || !guard.probes.length) throw new Error(`${label} report has an invalid or empty guard`);
    if (guards.has(guard.guard)) throw new Error(`${label} report has duplicate guard ${guard.guard}`);
    const probes = new Map();
    let expectedResult = 'pass';
    for (const probe of guard.probes) {
      if (!probe || typeof probe.id !== 'string' || !probe.id) throw new Error(`${label} report has a probe without a fixed id`);
      if (!['pass', 'fail', 'unverified'].includes(probe.result)) throw new Error(`${label} report has invalid result for ${guard.guard}/${probe.id}`);
      if (probes.has(probe.id)) throw new Error(`${label} report has duplicate probe id ${guard.guard}/${probe.id}`);
      probes.set(probe.id, probe);
      if (probe.result === 'fail') expectedResult = 'fail';
      else if (probe.result === 'unverified' && expectedResult === 'pass') expectedResult = 'unverified';
    }
    if (guard.result !== expectedResult) throw new Error(`${label} report has inconsistent result for ${guard.guard}`);
    hasFailure ||= expectedResult === 'fail';
    hasUnverified ||= expectedResult === 'unverified';
    guards.set(guard.guard, probes);
  }
  const runtimeUnverified = report.runtime.powerShell.used && report.runtime.powerShell.version === 'unknown';
  const expectedStatus = hasFailure ? 'error'
    : hasUnverified || report.integrity.state === 'unverified' || runtimeUnverified ? 'incomplete' : 'probe-pass';
  if (report.status !== expectedStatus) throw new Error(`${label} report has inconsistent aggregate status`);
  return { report, guards };
}

export function readReport(path, label) {
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} report is not valid JSON`); }
  return validateReport(report, label);
}

function validateRuntime(runtime, label) {
  if (!runtime || typeof runtime.node !== 'string' || !runtime.node || !runtime.os ||
    typeof runtime.os.platform !== 'string' || typeof runtime.os.type !== 'string' || typeof runtime.os.release !== 'string' ||
    !runtime.powerShell || typeof runtime.powerShell.used !== 'boolean' || typeof runtime.powerShell.version !== 'string') {
    throw new Error(`${label} report has incomplete runtime metadata`);
  }
  if (runtime.powerShell.used && runtime.powerShell.version !== 'unknown' && typeof runtime.powerShell.executable !== 'string') {
    throw new Error(`${label} report has no PowerShell executable`);
  }
}

function validFingerprint(value, allowUnregistered = false) {
  if (!value || typeof value.state !== 'string') return false;
  if (value.state === 'ok') return typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256);
  return value.state === 'unavailable' || (allowUnregistered && value.state === 'unregistered');
}

function validateSnapshot(snapshot, label) {
  if (!snapshot || !validFingerprint(snapshot.settings) || !snapshot.guards || !snapshot.sharedLexers) throw new Error(`${label} report has incomplete hash metadata`);
  if (GUARDS.some(name => !Object.hasOwn(snapshot.guards, name))) throw new Error(`${label} report has incomplete guard hashes`);
  if (Object.values(snapshot.guards).some(value => !validFingerprint(value, true)) ||
    Object.values(snapshot.sharedLexers).some(value => !validFingerprint(value))) throw new Error(`${label} report has invalid hash metadata`);
}

function validateIntegrity(integrity, label) {
  if (!integrity || !['stable', 'unverified'].includes(integrity.state)) throw new Error(`${label} report has invalid integrity state`);
  validateSnapshot(integrity.before, label);
  validateSnapshot(integrity.after, label);
  if (integrity.state === 'stable' && JSON.stringify(integrity.before) !== JSON.stringify(integrity.after)) {
    throw new Error(`${label} report claims stable inputs with changed hashes`);
  }
  if (integrity.state === 'stable' && [integrity.before, integrity.after].some(snapshot =>
    snapshot.settings.state !== 'ok' || Object.values(snapshot.guards).some(value => value.state !== 'ok') ||
    Object.values(snapshot.sharedLexers).some(value => value.state !== 'ok'))) {
    throw new Error(`${label} report claims stable inputs without complete hashes`);
  }
}

function outcome(probe) { return probe ? `${probe.result}:${probe.classification ?? 'unspecified'}` : null; }
function resultChange(guard, id, before, after) {
  if (!before) return { type: 'added', guard, probeId: id, current: outcome(after) };
  if (!after) return { type: 'missing', guard, probeId: id, previous: outcome(before) };
  if (before.result === after.result && before.classification === after.classification) {
    return before.result === 'fail' ? { type: 'unchanged-failure', guard, probeId: id, current: outcome(after) } : null;
  }
  if (after.result === 'pass' && before.result !== 'pass') return { type: 'improvement', guard, probeId: id, previous: outcome(before), current: outcome(after) };
  if (after.result === 'unverified') return { type: 'became-unverified', guard, probeId: id, previous: outcome(before), current: outcome(after) };
  if (before.result === 'pass' && after.classification === 'unexpected-allow') return { type: 'unexpected-allow', guard, probeId: id, previous: outcome(before), current: outcome(after) };
  if (before.result === 'pass' && after.classification === 'false-positive') return { type: 'false-positive', guard, probeId: id, previous: outcome(before), current: outcome(after) };
  return { type: 'changed', guard, probeId: id, previous: outcome(before), current: outcome(after) };
}

function valueAt(report, path) { return path.split('.').reduce((v, key) => v?.[key], report); }
function metadataChanges(previous, current) {
  const changes = [];
  for (const path of ['probeDefinitionVersion', 'runtime.os.platform', 'runtime.os.type', 'runtime.os.release', 'runtime.node', 'runtime.powerShell.used', 'runtime.powerShell.executable', 'runtime.powerShell.version', 'integrity.state']) {
    const before = valueAt(previous, path); const after = valueAt(current, path);
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ type: 'environment-or-definition', field: path, previous: before ?? null, current: after ?? null });
  }
  const beforeHashes = previous.integrity?.before ?? {};
  const afterHashes = current.integrity?.before ?? {};
  const compareHashes = (a, b, prefix) => {
    for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
      const before = a?.[key] ?? null; const after = b?.[key] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ type: 'target-hash', field: `${prefix}.${key}`, previous: before, current: after });
    }
  };
  if (JSON.stringify(beforeHashes.settings ?? null) !== JSON.stringify(afterHashes.settings ?? null)) changes.push({ type: 'target-hash', field: 'settings', previous: beforeHashes.settings ?? null, current: afterHashes.settings ?? null });
  compareHashes(beforeHashes.guards, afterHashes.guards, 'guards');
  compareHashes(beforeHashes.sharedLexers, afterHashes.sharedLexers, 'sharedLexers');
  return changes;
}

export function compare(previousInput, currentInput) {
  const changes = [];
  for (const guard of new Set([...previousInput.guards.keys(), ...currentInput.guards.keys()])) {
    const previous = previousInput.guards.get(guard) ?? new Map();
    const current = currentInput.guards.get(guard) ?? new Map();
    for (const id of new Set([...previous.keys(), ...current.keys()])) {
      const change = resultChange(guard, id, previous.get(id), current.get(id));
      if (change) changes.push(change);
    }
  }
  changes.sort((a, b) => `${a.guard}/${a.probeId}`.localeCompare(`${b.guard}/${b.probeId}`));
  const conditions = metadataChanges(previousInput.report, currentInput.report);
  const currentFullyPassing = [...currentInput.guards.values()].every(probes => [...probes.values()].every(p => p.result === 'pass')) && currentInput.report.status === 'probe-pass';
  const meaningfulResultChange = changes.some(c => c.type !== 'unchanged-failure');
  const exitCode = !meaningfulResultChange && !conditions.length && currentFullyPassing ? 0 : 1;
  return { schemaVersion: SCHEMA_VERSION, comparable: true, resultChanges: changes, conditionChanges: conditions, currentFullyPassing, exitCode };
}

export function printComparison(result) {
  console.log(`Probe report comparison: ${result.exitCode === 0 ? 'EQUAL AND PASSING' : 'ATTENTION REQUIRED'}`);
  for (const change of result.resultChanges) {
    const label = change.type === 'unchanged-failure' ? 'UNCHANGED FAILURE' : change.type.toUpperCase();
    console.log(`${label} ${change.guard}/${change.probeId}${change.previous ? `: ${change.previous}` : ''}${change.current ? ` -> ${change.current}` : ''}`);
  }
  for (const change of result.conditionChanges) console.log(`CONDITION ${change.type} ${change.field}: ${JSON.stringify(change.previous)} -> ${JSON.stringify(change.current)}`);
  if (!result.resultChanges.length && !result.conditionChanges.length && !result.currentFullyPassing) console.log('CURRENT REPORT IS NOT FULLY PASSING');
}

export function main(args = process.argv.slice(2)) {
  let previousPath; let currentPath; let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if ((args[i] === '--previous' || args[i] === '--current') && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (args[i] === '--previous') previousPath = args[++i]; else currentPath = args[++i];
    } else if (args[i] === '--help') { console.log(usage()); return 0; }
    else { console.error(`compare-probe-reports: unknown option or missing argument.\n${usage()}`); return 2; }
  }
  if (!previousPath || !currentPath) { console.error(usage()); return 2; }
  try {
    const result = compare(readReport(previousPath, 'previous'), readReport(currentPath, 'current'));
    if (json) console.log(JSON.stringify(result, null, 2)); else printComparison(result);
    return result.exitCode;
  } catch (error) {
    console.error(`compare-probe-reports: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
