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
 * TWO EVENTS, ONE FILE
 * This script is registered under two different hook events, and branches on
 * `hook_event_name` from its stdin payload:
 *
 *   - PreToolUse: pattern-matches Edit/Write/Bash/PowerShell calls against
 *     the protected paths below. Necessary for CLAUDE.md, hooks/, scripts/,
 *     and approvals/, none of which have a native "this file changed" event
 *     Claude Code can block on.
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
 * Exit 0 -> allow.  Exit 2 -> block, reason on stderr.
 * Any internal failure exits 0: a broken guard must not brick the toolchain.
 * This hook guards metadata about the other guards, not a destructive action
 * directly, so unlike guard-sql it fails open on its own errors, the same
 * choice guard-secrets makes.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CLAUDE_HOME = resolve(process.env.AIWF_CLAUDE_HOME || join(homedir(), '.claude'));

// Windows paths are case-insensitive end to end; C:\Users\X\.claude and
// c:\users\x\.claude name the same directory. Normalize case only for the
// home prefix itself, not the subpath names chosen below.
const HOME_NORM = CLAUDE_HOME.replaceAll('\\', '/').toLowerCase();

/** Directories and files inside the claude home that this hook protects. */
const PROTECTED_SUBPATHS = ['settings.json', 'CLAUDE.md', 'hooks', 'scripts', 'approvals'];

const FILE_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;

/** The protected subpath a piece of text names, or null. */
function protectedSubpathIn(text) {
  const norm = text.replaceAll('\\', '/').toLowerCase();
  for (const sub of PROTECTED_SUBPATHS) {
    if (norm.includes(`${HOME_NORM}/${sub.toLowerCase()}`)) return sub;
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
    const sub = protectedSubpathIn(m[1]);
    if (sub) return { sub, via: 'output redirection' };
  }
  if (INPLACE_EDIT_RE.test(segment)) {
    const sub = protectedSubpathIn(segment);
    if (sub) return { sub, via: 'in-place edit (sed/perl -i)' };
  }
  const word = commandWord(segment);
  if (WRITE_COMMANDS.includes(word)) {
    const sub = protectedSubpathIn(segment);
    if (sub) return { sub, via: word };
  }
  return null;
}

function denyPreToolUse(hit, detail) {
  process.stderr.write(
    `[guard-config] BLOCKED: this call would modify or delete this kit's own guardrails.\n\n` +
      `Protected path : ${CLAUDE_HOME}/${hit.sub}\n` +
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
    // payload does carry a source field and it names something else, skip
    // rather than block, on the theory that an unrecognized source is more
    // likely a Claude Code change we have not accounted for than a reason to
    // widen this hook's blast radius by accident.
    const source = typeof payload.source === 'string' ? payload.source : null;
    if (!source || source === 'user_settings') denyConfigChange();
    process.exit(0);
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolInput = payload.tool_input;

  if (FILE_TOOL_RE.test(toolName)) {
    const filePath = toolInput && typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    if (filePath) {
      const sub = protectedSubpathIn(filePath);
      if (sub) denyPreToolUse({ sub, via: `${toolName} tool` }, filePath);
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
