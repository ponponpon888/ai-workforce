#!/usr/bin/env node
/**
 * guard-config.mjs — Claude Code hook. Stops the agent from modifying or
 * deleting this kit's own guardrails, and refuses live edits to the
 * installed settings.json outright.
 *
 * WHY THIS EXISTS
 * Nothing in guard-sql or guard-secrets stops Claude Code from editing
 * ~/.claude/settings.json, ~/.claude/CLAUDE.md, the hook scripts themselves,
 * or the scripts/approve-ddl.* approval tooling. A model asked to "fix" a
 * confirmation prompt it finds in the way, or one working from a poisoned
 * instruction, can quietly remove or rewrite the guard instead of working
 * within it.
 *
 * It also covers ~/.claude/approvals/. guard-sql's DDL gate is only as good
 * as the claim that a file there was written by a human running
 * approve-ddl.* themselves, outside the agent's tool loop. Nothing before
 * this hook stopped the agent from writing that file directly: the SHA-256
 * fingerprint algorithm is public, in this same repository, so an agent that
 * computes it can manufacture its own approval token and self-approve DDL
 * that was never shown to a human at all. Blocking every Claude-Code-mediated
 * write to approvals/ closes that — the only path left to create an approval
 * is a human running the script themselves, in their own terminal. See
 * data/pitfalls/hook-006.json.
 *
 * THREE EVENTS, ONE FILE
 * This script is registered under three different hook events, and branches
 * on `hook_event_name` from its stdin payload:
 *
 *   - PreToolUse: pattern-matches Edit/Write/Bash/PowerShell calls against
 *     the protected paths below. Necessary for CLAUDE.md, hooks/, scripts/,
 *     approvals/, and known-good/, none of which have a native "this file
 *     changed" event Claude Code can block on.
 *   - ConfigChange: Claude Code's own file watcher fires this whenever
 *     ~/.claude/settings.json (a "user_settings" source) actually changes,
 *     by any means at all -- not just the write shapes this file's
 *     PreToolUse branch happens to recognize. It can block the change
 *     outright (exit 2 or {"decision":"block"}), so for settings.json this
 *     is a second, more authoritative layer; the PreToolUse branch still
 *     runs first and usually catches the attempt earlier. ConfigChange's
 *     matcher is a configuration *source*, not an arbitrary file, so it has
 *     no reach into CLAUDE.md/hooks//scripts//approvals -- those stay on
 *     PreToolUse only.
 *
 *     Confirmed live on Claude Code 2.1.274 (Windows): editing settings.json
 *     from outside Claude Code while a session is running does fire this
 *     hook and does keep that session from adopting the change. It does NOT
 *     revert the file on disk, and a change made while no session is running
 *     becomes the new baseline on next launch, invisible to this hook --
 *     ConfigChange only ever sees a change against what a running session
 *     already loaded. See data/pitfalls/hook-007.json. Treat this layer as
 *     "the running session keeps using known-good permissions", not as
 *     "the file is tamper-evident across restarts".
 *
 *   - SessionStart: fills the gap ConfigChange leaves open. At every launch
 *     or resume, compares the installed settings.json against a copy saved
 *     under known-good/ (recorded at install time by install.mjs/.ps1, or
 *     re-recorded by hand with record-settings-baseline.mjs/.ps1 after a
 *     deliberate edit). A mismatch means the file changed by some path this
 *     kit never saw -- including the exact hook-007 scenario, a change
 *     ConfigChange blocked from a session that landed on disk anyway.
 *
 *     Per Claude Code's own hooks reference (code.claude.com/docs/en/hooks,
 *     checked 2026-09-18): SessionStart CANNOT block startup. Exit 2 and any
 *     "decision" field are ignored outright; the session starts regardless.
 *     So this is detection, not prevention -- it surfaces a warning through
 *     `additionalContext` (Claude sees it as context at the very start of
 *     the session and can act on it) and `systemMessage` (the human sees it
 *     directly), never a hard stop. See data/pitfalls/hook-011.json for the
 *     residual gap this leaves and why it was accepted rather than chased
 *     further.
 *
 *     No baseline recorded yet (a fresh upgrade of an older install, or the
 *     known-good/ directory was lost) is not treated as a mismatch: the
 *     current file is trusted once, recorded as the new baseline, and a
 *     one-time informational note is surfaced instead of a warning. Silent
 *     trust-on-first-use, not a block, for the same reason install.mjs does
 *     not require a human to bless day-one settings.json by hand.
 *
 * SCOPE
 * The PreToolUse branch is path-name matching, the same approach as
 * guard-secrets: it looks for the installed claude home's path as a literal
 * substring, not a resolved, symlink-free path. Neither branch covers
 * indirect rewrites — `git checkout` of an old commit inside a
 * version-controlled claude home, a package script, an editor plugin. This
 * stops the common case of the agent reaching for Edit, Write, or a shell
 * command; it is not a boundary against an adversary who already controls
 * the machine.
 *
 * A deliberate trade: a human who genuinely wants Claude Code to update their
 * CLAUDE.md or settings.json now has to do it by hand, or ask a session with
 * a different claude home. That is the point — these files are meant to
 * change through the person's own hands or the installer, not through a tool
 * call the agent decided to make.
 *
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr. (SessionStart is the
 * exception: Claude Code ignores its exit code and any decision field
 * outright, so that branch always exits 0 and speaks through stdout JSON
 * instead -- see the SessionStart bullet above.)
 * Any internal failure exits 0: a broken guard must not brick the toolchain.
 * This hook guards metadata about the other guards, not a destructive action
 * directly, so unlike guard-sql it fails open on its own errors, the same
 * choice guard-secrets makes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The claude home this hook belongs to.
 *
 * Installed, this file sits at <claude home>/hooks/guard-config.mjs, so its
 * own location names the home Claude Code is reading when it invokes the
 * hook. Deciding from ~/.claude alone meant that installing anywhere else
 * (install.mjs --claude-home, or CLAUDE_CONFIG_DIR) left the settings.json
 * actually in use unprotected, while the hook was registered and every static
 * check still passed -- the exact shape of "guarded, but guarding nothing"
 * this kit exists to avoid. See data/pitfalls/hook-013.json.
 */
const OWN_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOME = resolve(join(homedir(), '.claude'));
const CLAUDE_HOME = resolve(process.env.AIWF_CLAUDE_HOME || OWN_HOME);

/**
 * The home derived from the path this hook was *invoked* by, which is the
 * spelling written into settings.json.
 *
 * Node's ESM loader resolves symlinks, so import.meta.url above is always the
 * canonical path -- on macOS a home under tmpdir() is registered as
 * /var/folders/... and arrives here as /private/var/folders/..., and on
 * Windows an 8.3 short path arrives expanded. Since the checks below match
 * paths as text, the spelling the agent will actually type would then match
 * nothing. process.argv[1] keeps the path as invoked; both are protected.
 */
const INVOKED_HOME = process.argv[1] ? resolve(dirname(process.argv[1]), '..') : null;

/**
 * Every home this hook refuses to let an agent rewrite.
 *
 * With AIWF_CLAUDE_HOME set, it is exactly that one: the variable is an
 * explicit "protect this and nothing else", which is how the tests pin
 * behaviour to a throwaway directory.
 *
 * Without it, the default home is protected alongside the installed one. A
 * copy of this hook registered straight from a checkout would otherwise stop
 * protecting ~/.claude, which it does today -- widening what is refused is
 * safe, narrowing it silently is not.
 *
 * Each home contributes every spelling that names it (see INVOKED_HOME): a
 * path that resolves to a protected home must be refused however it is
 * written, and listing an extra spelling of a home already protected can only
 * refuse more.
 */
const PROTECTED_HOMES = [...new Set((process.env.AIWF_CLAUDE_HOME
  ? [CLAUDE_HOME]
  : [CLAUDE_HOME, INVOKED_HOME, DEFAULT_HOME]).filter(Boolean))];

// Windows paths are case-insensitive end to end; C:\Users\X\.claude and
// c:\users\x\.claude name the same directory. Normalize case only for the
// home prefix itself, not the subpath names chosen below.
const HOME_NORMS = PROTECTED_HOMES.map(home => home.replaceAll('\\', '/').toLowerCase());

/**
 * Directories and files inside the claude home that this hook protects.
 * known-good/ holds the SessionStart baseline (below) -- it needs the same
 * protection as approvals/: if Claude Code could write it, a tampered
 * settings.json and a freshly "approved" baseline could land together and
 * the SessionStart check would never see a mismatch.
 */
const PROTECTED_SUBPATHS = ['settings.json', 'CLAUDE.md', 'hooks', 'scripts', 'approvals', 'known-good'];

const KNOWN_GOOD_DIR = join(CLAUDE_HOME, 'known-good');
const KNOWN_GOOD_SETTINGS = join(KNOWN_GOOD_DIR, 'settings.json');
const INSTALLED_SETTINGS = join(CLAUDE_HOME, 'settings.json');

const FILE_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;

/** The protected subpath a piece of text names, or null. */
function protectedSubpathIn(text) {
  const norm = text.replaceAll('\\', '/').toLowerCase();
  for (let i = 0; i < HOME_NORMS.length; i++) {
    for (const sub of PROTECTED_SUBPATHS) {
      // The home is reported back so the block message names the directory
      // that was actually matched, not whichever one happens to be first.
      if (norm.includes(`${HOME_NORMS[i]}/${sub.toLowerCase()}`)) return { sub, home: PROTECTED_HOMES[i] };
    }
  }
  return null;
}

/**
 * Commands that write, overwrite, rename, or delete a file. Matched against
 * the leading word of a shell segment, the same shape as guard-secrets'
 * reader list. `cp`/`copy-item` etc. are treated as writers regardless of
 * which argument is the protected path — copying a protected file out is
 * blocked too, along with copying one in. Back it up by hand instead.
 */
const WRITE_COMMANDS = [
  // POSIX
  'rm', 'cp', 'mv', 'tee', 'truncate', 'install', 'dd', 'shred', 'ln',
  // PowerShell (cmdlet names and their common aliases)
  'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir',
  'copy-item', 'cp', 'copy',
  'move-item', 'mv', 'move',
  'rename-item', 'ren',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc',
  'new-item', 'ni',
];

/** sed -i / perl -i edit the file named elsewhere on the same line, in place. */
const INPLACE_EDIT_RE = /(?:^|\s)(?:sed|perl)\s+.*-i\b/;

/**
 * Redirection into a file: `> path`, `>> path` — the same operators in both
 * POSIX shells and PowerShell. The negative lookarounds keep `<path` and
 * `>>>` from being misread; they do not need to be exact, only to avoid
 * capturing the wrong token as the destination.
 */
const OUTPUT_REDIRECT_RE = /(?<!<)>>?(?!>)\s*([^\s;|&<>]+)/g;

function leafOf(token) {
  const bare = token.replace(/^['"]+|['"]+$/g, '');
  return (bare.split(/[\\/]/).pop() || bare).toLowerCase().replace(/\.exe$/, '');
}

/** The command word of a segment: leading env assignments and sudo are prefixes. */
function commandWord(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'command')
  ) {
    i++;
  }
  if (i >= tokens.length) return '';
  return leafOf(tokens[i]);
}

/**
 * One command line can be several commands. `&&`/`||`/`;`/newline/`$(` all
 * split it, so `cd /tmp && rm <path>` is inspected as two segments and the
 * second one alone decides the verdict — a wrapper in front does not hide it.
 */
function segmentsOf(command) {
  return command.split(/&&|\|\||[;|&\n\r]|\$\(/);
}

/** Why this segment counts as a write to a protected path, or null. */
function writerHitIn(segment) {
  OUTPUT_REDIRECT_RE.lastIndex = 0;
  let m;
  while ((m = OUTPUT_REDIRECT_RE.exec(segment)) !== null) {
    const hit = protectedSubpathIn(m[1]);
    if (hit) return { ...hit, via: 'output redirection' };
  }
  if (INPLACE_EDIT_RE.test(segment)) {
    const hit = protectedSubpathIn(segment);
    if (hit) return { ...hit, via: 'in-place edit (sed/perl -i)' };
  }
  const word = commandWord(segment);
  if (WRITE_COMMANDS.includes(word)) {
    const hit = protectedSubpathIn(segment);
    if (hit) return { ...hit, via: word };
  }
  return null;
}

function denyPreToolUse(hit, detail) {
  process.stderr.write(
    `[guard-config] BLOCKED: this call would modify or delete this kit's own guardrails.\n\n` +
      `Protected path : ${hit.home}/${hit.sub}\n` +
      `Matched by     : ${hit.via}\n` +
      (detail ? `Command/target : ${detail}\n` : '') +
      `\nWhat to do:\n` +
      `  1. If this change is intentional, make it yourself outside Claude Code —\n` +
      `     edit the file directly, or run the script in your own terminal.\n` +
      `  2. Do not look for a different tool or command to reach the same file;\n` +
      `     this hook matches by path, not by which tool asked.\n`
  );
  process.exit(2);
}

/**
 * ConfigChange has no message surfaced to Claude or the user on a block
 * (Anthropic's own docs say so). Writing to stderr is still worth doing for
 * anyone reading the debug log, and printing the JSON decision alongside
 * exit 2 is belt-and-suspenders: exit 2 blocks "whether or not you print
 * JSON", per the hooks reference, so this does not depend on the decision
 * schema being exactly right.
 */
function denyConfigChange() {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: "guard-config: this kit's settings.json is not editable from inside Claude Code.",
  }) + '\n');
  process.stderr.write(
    '[guard-config] BLOCKED: a ConfigChange to the installed settings.json was refused.\n' +
    'Edit it yourself, outside Claude Code, if this change is intentional.\n'
  );
  process.exit(2);
}

/**
 * Emits SessionStart's supported JSON output. additionalContext reaches
 * Claude directly (SessionStart is one of the few events whose stdout the
 * model actually sees, per the hooks reference); systemMessage reaches the
 * human. Both are best-effort -- SessionStart ignores exit codes and
 * decision fields entirely, so there is no "block" branch to fall back to.
 */
function warnSessionStart(message, systemMessage) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart' },
    additionalContext: message,
    systemMessage,
  }) + '\n');
  process.stderr.write(message + '\n');
}

/**
 * Compares the installed settings.json against the known-good/ baseline.
 * See data/pitfalls/hook-007.json for the gap this closes (detection, not
 * prevention -- SessionStart cannot block startup) and hook-011.json for
 * that limitation itself. Never throws: any failure here falls through to
 * the outer try/catch and exits 0, same fail-open posture as the rest of
 * this hook.
 */
function checkSessionStartBaseline() {
  let current;
  try {
    current = readFileSync(INSTALLED_SETTINGS);
  } catch {
    return; // No installed settings.json at all; nothing to compare.
  }

  let baseline;
  try {
    baseline = readFileSync(KNOWN_GOOD_SETTINGS);
  } catch {
    // No baseline yet: an install that predates this check, or known-good/
    // was lost. Trust the current file once rather than warn on every
    // session forever -- the same trade-off install.mjs already makes for
    // day-one settings.json.
    try {
      mkdirSync(KNOWN_GOOD_DIR, { recursive: true });
      writeFileSync(KNOWN_GOOD_SETTINGS, current);
    } catch {
      // Could not record a baseline (read-only filesystem, permissions).
      // Fail open: say nothing rather than warn every single session with
      // no way for the human to make the warning go away.
      return;
    }
    warnSessionStart(
      `[guard-config] settings.json baseline recorded for the first time (${KNOWN_GOOD_SETTINGS}). ` +
        `If ${INSTALLED_SETTINGS} does not reflect a version you trust, review it now and re-record ` +
        `with record-settings-baseline once it is correct.`,
      'guard-config: settings.json baseline recorded for the first time.'
    );
    return;
  }

  if (Buffer.compare(current, baseline) === 0) return; // matches; say nothing

  warnSessionStart(
    `[guard-config] WARNING: ${INSTALLED_SETTINGS} does not match its last recorded baseline ` +
      `(${KNOWN_GOOD_SETTINGS}). It may have been edited while Claude Code was not running, or a ` +
      'change that ConfigChange blocked from an earlier session still landed on disk (see ' +
      'data/pitfalls/hook-007.json). Review the file yourself before trusting it. If this change is ' +
      'intentional, re-record the baseline outside Claude Code with record-settings-baseline.',
    'guard-config: settings.json changed since the last recorded baseline -- see additional context.'
  );
}

function readStdin() {
  return new Promise((res) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => res(raw));
    process.stdin.on('error', () => res(''));
  });
}

try {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  const payload = JSON.parse(raw);
  const hookEventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';

  if (hookEventName === 'ConfigChange') {
    // settings.json's own hooks.ConfigChange matcher is already scoped to
    // "user_settings", so this only ever fires for the installed
    // ~/.claude/settings.json. The extra check here is defensive: if the
    // payload does carry a config_source field and it names something else,
    // skip rather than block, on the theory that an unrecognized source is
    // more likely a Claude Code change we have not accounted for than a
    // reason to widen this hook's blast radius by accident.
    //
    // The field is config_source, not source -- corrected 2026-09-18 against
    // code.claude.com/docs/en/hooks. The old name meant this check always
    // read undefined and fell through to the "deny" branch regardless of
    // the real value, which happened to match the intended behaviour only
    // because the matcher above already restricts invocation to
    // user_settings; a broader matcher would have blocked config sources
    // this hook was never meant to touch. Not re-measured live (no source
    // field mismatch was ever visible in the hook-007 repro, which only
    // ever sent user_settings), so this fix is documented confidence, not
    // measured -- see data/pitfalls/hook-011.json.
    const source = typeof payload.config_source === 'string' ? payload.config_source : null;
    if (!source || source === 'user_settings') denyConfigChange();
    process.exit(0);
  }

  if (hookEventName === 'SessionStart') {
    // Matcher entries can restrict this to startup|resume, but check here
    // too in case of a custom, broader registration -- the same defensive
    // posture as the ConfigChange source check above. clear/compact/fork
    // happen inside an already-running process, where ConfigChange is
    // already watching; re-checking the baseline there would be redundant,
    // not wrong, so skip rather than guess if the field is absent.
    const startupType = typeof payload.startup_type === 'string' ? payload.startup_type : null;
    if (!startupType || startupType === 'startup' || startupType === 'resume') checkSessionStartBaseline();
    process.exit(0);
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolInput = payload.tool_input;

  if (FILE_TOOL_RE.test(toolName)) {
    const filePath = toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    if (filePath) {
      const hit = protectedSubpathIn(filePath);
      if (hit) denyPreToolUse({ ...hit, via: `${toolName} tool` }, filePath);
    }
  } else if (SHELL_TOOL_RE.test(toolName)) {
    const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : '';
    if (command.trim()) {
      for (const segment of segmentsOf(command)) {
        if (!segment.trim()) continue;
        const hit = writerHitIn(segment);
        if (hit) denyPreToolUse(hit, segment.trim());
      }
    }
  }

  process.exit(0);
} catch {
  // A failed inspection is not a successful safety check, but this hook
  // guards metadata about the other guards rather than a destructive action
  // directly — fail open, as guard-secrets does, rather than block every
  // tool call kit-wide over an unparseable payload.
  process.exit(0);
}
