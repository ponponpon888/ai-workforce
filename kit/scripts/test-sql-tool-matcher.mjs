// The three places that decide whether a tool call reaches guard-sql must name
// the same database products.
//
// There are three, not one:
//   1. kit/claude/settings.json   -- the matcher Claude Code routes by
//   2. kit/claude/hooks/guard-sql.mjs  -- SQL_TOOL_RE, the hook's own check
//   3. kit/claude/hooks/guard-sql.ps1  -- the same check in the twin
//
// data/pitfalls/hook-004.json recorded that (1) and (2) must stay in step, and
// left keeping them so to whoever edits them next. That is how it drifted: the
// MySQL/SQLite work added mysql, mariadb and sqlite to (2) and (3) and not to
// (1), so the hook understood statements over those MCP servers and Claude Code
// never handed it one. Nothing failed -- doctor reported static-pass, every
// suite was green, and the guard simply was not asked.
//
// So the agreement is checked here rather than remembered. Adding a product to
// the hook without adding it to the matcher now fails, and vice versa.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

/** The products an `mcp__.*[Xx]yz` alternation names, lower-cased and sorted. */
const productsIn = (pattern) => [...pattern.matchAll(/mcp__\.\*\[(\w)(\w)\]([A-Za-z]+)/g)]
  .map(m => (m[1] + m[3]).toLowerCase()).sort();

const settings = JSON.parse(read('kit', 'claude', 'settings.json'));
const sqlEntry = settings.hooks.PreToolUse.find(e => /mcp__/.test(e.matcher || ''));
const lineWith = (file, needle) => {
  const line = read('kit', 'claude', 'hooks', file).split('\n').find(l => l.includes(needle));
  assert.ok(line, `${file}: no line containing ${JSON.stringify(needle)} -- the check below is reading the wrong thing`);
  return line;
};

const sources = {
  'settings.json': sqlEntry?.matcher ?? '',
  'guard-sql.mjs': lineWith('guard-sql.mjs', 'SQL_TOOL_RE'),
  'guard-sql.ps1': lineWith('guard-sql.ps1', '$toolName -notmatch'),
};

test('the matcher and both hooks name the same MCP products', () => {
  const [first, ...rest] = Object.entries(sources).map(([where, text]) => [where, productsIn(text)]);
  assert.ok(first[1].length > 0, 'found no products at all -- the extraction is broken, not the sources');
  for (const [where, list] of rest) {
    assert.deepEqual(list, first[1],
      `${where} names ${list.join(' ') || '(none)'}; ${first[0]} names ${first[1].join(' ')}`);
  }
});

// hook-004's actual finding: a real connector puts its own name in the prefix,
// so mcp__[Ss]upabase__.* misses mcp__claude_ai_Supabase__list_projects. Every
// product is checked in that shape, in all three places.
test('each product matches a connector-prefixed tool name', () => {
  for (const [where, text] of Object.entries(sources)) {
    const pattern = where === 'settings.json'
      ? text
      : (text.match(/\/(.+)\/[a-z]*;?\s*$/)?.[1] ?? text.match(/'([^']+)'/)?.[1] ?? '');
    assert.ok(pattern, `${where}: could not read a pattern out of ${JSON.stringify(text.slice(0, 60))}`);
    const re = new RegExp(pattern);
    for (const product of productsIn(text)) {
      const capitalized = product[0].toUpperCase() + product.slice(1);
      for (const name of [`mcp__${product}__query`, `mcp__claude_ai_${capitalized}__query`]) {
        assert.ok(re.test(name), `${where} does not match ${name}`);
      }
    }
  }
});

// Bash and PowerShell reach guard-sql too, and nothing else should by name.
test('the shell tools are routed and an unrelated tool is not', () => {
  const re = new RegExp(sqlEntry.matcher);
  for (const name of ['Bash', 'PowerShell']) assert.ok(re.test(name), `${name} is not routed`);
  for (const name of ['Read', 'mcp__GitHub__search_code']) assert.ok(!re.test(name), `${name} should not be routed`);
});
