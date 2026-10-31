#!/usr/bin/env node
/**
 * Record a guard probe before a manual change, then record and compare it
 * afterwards. This command never changes the target settings or hooks.
 */
import { closeSync, existsSync, linkSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from './probe-guards.mjs';
import { compare, printComparison, readReport, validateReport } from './compare-probe-reports.mjs';

function usage() {
  return 'node kit/scripts/record-probe-reports.mjs before --claude-home PATH --output PATH [--json]\n' +
    'node kit/scripts/record-probe-reports.mjs after --claude-home PATH --previous PATH --output PATH [--json]\n' +
    'Runs the named probe target only. It never updates settings or hooks, and refuses to overwrite reports.\n' +
    'Exit: 0 successful record / equal passing comparison; 1 a recorded probe failed or comparison needs attention; 2 invalid input, incomplete probe, or save failure.';
}

function outputPath(path) {
  const result = resolve(path);
  if (existsSync(result)) throw new Error(`output already exists: ${result}`);
  return result;
}

function isSamePath(previous, output) {
  return resolve(previous) === resolve(output);
}

function writeNewReport(path, report) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    // wx prevents a stale temporary file from being overwritten. The hard link
    // publishes the complete file only if the requested destination is still new.
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function record({ claudeHome, output, probeRunner = probe }) {
  let report;
  try {
    report = probeRunner({ claudeHome });
  } catch {
    return { exitCode: 2, error: 'probe could not start; no report was saved' };
  }
  if (!report || report.status === 'incomplete') {
    return { exitCode: 2, error: 'probe was incomplete; no report was saved' };
  }
  let input;
  try {
    input = validateReport(report, 'new');
  } catch (error) {
    return { exitCode: 2, error: `probe produced an unusable report: ${error.message}` };
  }
  try {
    writeNewReport(output, report);
  } catch {
    return { exitCode: 2, error: 'report could not be saved without overwriting an existing file' };
  }
  return { exitCode: report.status === 'probe-pass' ? 0 : 1, input };
}

function targetOf(input, label) {
  if (typeof input.report.claudeHome !== 'string' || !input.report.claudeHome ||
    typeof input.report.protectedHome !== 'string' || !input.report.protectedHome) {
    throw new Error(`${label} report has incomplete probe target metadata`);
  }
  return { claudeHome: resolve(input.report.claudeHome), protectedHome: resolve(input.report.protectedHome) };
}

export function runBefore({ claudeHome, output, probeRunner = probe }) {
  const recorded = record({ claudeHome, output, probeRunner });
  return { mode: 'before', output, ...recorded };
}

export function runAfter({ claudeHome, previous, output, probeRunner = probe }) {
  let previousInput;
  try {
    previousInput = readReport(previous, 'previous');
    const previousTarget = targetOf(previousInput, 'previous');
    if (previousTarget.claudeHome !== claudeHome) {
      return { mode: 'after', output, exitCode: 2, error: 'previous report was recorded for a different probe target' };
    }
  } catch (error) {
    return { mode: 'after', output, exitCode: 2, error: error.message };
  }
  const recorded = record({ claudeHome, output, probeRunner });
  if (!recorded.input) return { mode: 'after', output, ...recorded };
  try {
    const previousTarget = targetOf(previousInput, 'previous');
    const currentTarget = targetOf(recorded.input, 'current');
    if (previousTarget.protectedHome !== currentTarget.protectedHome) {
      return { mode: 'after', output, exitCode: 2, input: recorded.input, error: 'current probe protects a different target; reports were not compared' };
    }
  } catch (error) {
    return { mode: 'after', output, exitCode: 2, input: recorded.input, error: error.message };
  }
  const result = compare(previousInput, recorded.input);
  return { mode: 'after', output, ...recorded, comparison: result, exitCode: result.exitCode };
}

function parse(args) {
  const mode = args[0];
  if (!['before', 'after'].includes(mode)) throw new Error(usage());
  let claudeHome; let output; let previous; let json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if ((args[i] === '--claude-home' || args[i] === '--output' || args[i] === '--previous') && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      if (args[i - 1] === '--claude-home') claudeHome = resolve(value);
      else if (args[i - 1] === '--output') output = value;
      else previous = value;
    } else if (args[i] === '--help') throw new Error(usage());
    else throw new Error(`unknown option or missing argument\n${usage()}`);
  }
  if (!claudeHome || !output || (mode === 'after' && !previous)) throw new Error(usage());
  const outputFile = outputPath(output);
  if (mode === 'after' && isSamePath(previous, outputFile)) throw new Error('previous and output must be different files');
  return { mode, claudeHome, output: outputFile, previous: previous && resolve(previous), json };
}

export function main(args = process.argv.slice(2), options = {}) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage());
    return 0;
  }
  let parsed;
  try { parsed = parse(args); }
  catch (error) { console.error(`record-probe-reports: ${error.message}`); return 2; }
  const outcome = parsed.mode === 'before'
    ? runBefore({ ...parsed, probeRunner: options.probeRunner ?? probe })
    : runAfter({ ...parsed, probeRunner: options.probeRunner ?? probe });
  if (parsed.json) {
    console.log(JSON.stringify({ mode: outcome.mode, output: outcome.output, reportStatus: outcome.input?.report.status ?? null, comparison: outcome.comparison ?? null, error: outcome.error ?? null }, null, 2));
  } else if (outcome.error) {
    console.error(`record-probe-reports: ${outcome.error}`);
  } else if (outcome.mode === 'before') {
    console.log(outcome.exitCode === 0 ? `Saved successful baseline report: ${outcome.output}` : `Saved failed baseline report (not a successful baseline): ${outcome.output}`);
  } else {
    console.log(`Saved current probe report: ${outcome.output}`);
    printComparison(outcome.comparison);
  }
  return outcome.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
