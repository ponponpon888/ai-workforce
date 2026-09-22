#!/usr/bin/env node
/**
 * check-doc-commands.mjs -- The expected output printed beside a command in
 * the docs is what that command actually prints.
 *
 * The READMEs already carry the suites' results next to the command:
 *
 *     node kit/scripts/test-guard-sql.mjs    # pass: 87   fail: 0
 *
 * Nobody ran them, so they aged. Measured when this was written: guard-sql
 * printed 91 and guard-config 53, while ten places across README.md and
 * README.en.md still said 87 and 45. A reader who ran the command saw numbers
 * that did not match the page they were reading it from -- on the page whose
 * whole argument is "measure it, do not assume".
 *
 * It is the same failure as doc-001, one level out: there the prose quoted a
 * record's field, here it quotes a command's output. Both were written as a
 * note to humans and both drifted. The repair is the same -- make the machine
 * read what the prose asserts.
 *
 * Nothing is invented for this: the comment is the repository's own existing
 * convention, and this just runs it.
 *
 * What is checked:
 *   - every line inside a fenced block of the form
 *       node kit/scripts/test-<name>.mjs   # pass: <n>   fail: <n>
 *     in any Markdown file check-doc-links reads. The comment is always
 *     written that way; the suite itself may answer in either of the two
 *     shapes used here (this repository's own runner, or node:test's TAP).
 *
 * What is not, and why:
 *   - anything else in a fenced block. ONLY a `kit/scripts/test-*.mjs` path
 *     that exists is ever executed, and never with arguments taken from the
 *     document: a checker that ran what a page told it to would be a way to
 *     run anything by editing a page.
 *   - the PowerShell twins. The convention is only written on the `node`
 *     lines, and `pwsh` is not on every runner this could run on.
 *   - counts written in prose rather than beside the command. There is no
 *     command to run for those, so the fix for a stale one is to move it next
 *     to the command -- which is what this change does to the ones it found.
 *
 *   node kit/scripts/check-doc-commands.mjs
 *
 * Exit 0 -> every documented result matches.  Exit 1 -> at least one does not,
 * listed on stdout.  Exit 2 -> called wrongly, or the docs could not be read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docFiles } from './check-doc-links.mjs';

// The script name is bounded by the pattern itself: no slash, no dot, no
// space. Nothing from the document ever reaches a shell -- execFileSync takes
// the resolved path as a single argument with no shell in between.
const COMMAND = /^\s*node\s+kit\/scripts\/(test-[a-z0-9-]+\.mjs)\s+#\s*pass:\s*(\d+)\s+fail:\s*(\d+)\s*$/;
// Two suite families print their totals differently, and a checker that knew
// only one would quietly treat the other as unreadable. The guard suites use
// this repository's own runner ("pass: 91   fail: 0"); the rest are node:test
// files, which print TAP ("# pass 30" and "# fail 0" on separate lines).
const RESULT = /^pass:\s*(\d+)\s+fail:\s*(\d+)\s*$/m;
const TAP_PASS = /^# pass (\d+)$/m;
const TAP_FAIL = /^# fail (\d+)$/m;

/** {pass, fail} from either output shape, or null if neither is there. */
function resultIn(stdout) {
  const own = RESULT.exec(stdout);
  if (own) return { pass: Number(own[1]), fail: Number(own[2]) };
  const pass = TAP_PASS.exec(stdout);
  const fail = TAP_FAIL.exec(stdout);
  if (pass && fail) return { pass: Number(pass[1]), fail: Number(fail[1]) };
  return null;
}

/** Every documented "command # expected output" line, with its line number. */
export function commandsIn(text) {
  const found = [];
  let fence = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only inside a fence: prose that happens to mention the command is not a
    // promise about what it prints. Fence handling matches check-doc-links.
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { fence = null; continue; }
      const m = COMMAND.exec(line);
      if (m) found.push({ line: i + 1, script: m[1], pass: Number(m[2]), fail: Number(m[3]) });
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) fence = open[1];
  }
  return found;
}

/** What the suite prints now: {pass, fail}, or a reason it could not be read. */
export function runSuite(root, script) {
  const path = join(root, 'kit', 'scripts', script);
  if (!existsSync(path) || !statSync(path).isFile()) return { why: 'no such script' };
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [path], { cwd: root, encoding: 'utf8', timeout: 300000 });
  } catch (e) {
    // A suite that fails is test.yml's business, not this script's. Report
    // what was seen rather than swallowing it into a count mismatch.
    stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const result = resultIn(stdout);
    if (!result) return { why: `the suite did not run (${e.code ?? e.message})` };
    return result;
  }
  const result = resultIn(stdout);
  if (!result) return { why: 'the suite printed no result line this can read' };
  return result;
}

export function checkCommands(root, run = runSuite) {
  const findings = [];
  const seen = new Map();
  let checked = 0;
  for (const path of docFiles(root)) {
    for (const c of commandsIn(readFileSync(join(root, path), 'utf8'))) {
      if (!seen.has(c.script)) seen.set(c.script, run(root, c.script));
      const actual = seen.get(c.script);
      checked++;
      const at = { path: path.split('\\').join('/'), line: c.line, script: c.script };
      if (actual.why) { findings.push({ ...at, why: actual.why }); continue; }
      if (actual.pass === c.pass && actual.fail === c.fail) continue;
      findings.push({ ...at,
        why: `the page says pass: ${c.pass}  fail: ${c.fail}, the suite prints pass: ${actual.pass}  fail: ${actual.fail}` });
    }
  }
  return { findings, checked, suites: seen.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('This command takes no arguments.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const { findings, checked, suites } = checkCommands(root);
    for (const f of findings) console.log(`${JSON.stringify(f.path)}:${f.line}: ${f.script} -- ${f.why}`);
    console.log(`${findings.length} documented result(s) wrong; ${checked} checked across ${suites} suite(s).`);
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error('Cannot check documented commands: invalid arguments, or the docs could not be read.');
    process.exitCode = 2;
  }
}
