import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTodos, checkDocs } from './check-doc-todos.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for (const [name, text, expected] of [
  ['empty marker', 'TODO:', [1]],
  ['plain marker', 'TODO: finish', [1]],
  ['task list', '- [ ] TODO(owner): finish', [1]],
  ['heading', '## TODO: finish', [1]],
  ['numbered list', '1. TODO: finish', [1]],
  ['prose mention', 'Use TODO in examples.', []],
  ['inline code', '`TODO: example`', []],
  ['fenced example', '```sh\ngrep -r TODO src/\nTODO: example\n```\nTODO: finish', [5]],
  ['tilde fence', '~~~\nTODO: example\n~~~\nTODO: finish', [4]],
  ['long fence', '````\n```\nTODO: example\n````\nTODO: finish', [5]],
  ['indented code', '    TODO: example\n\tTODO: example', []],
  ['CRLF', 'text\r\nTODO: finish\r\n', [2]],
]) test(name, () => assert.deepEqual(findTodos(text).map(f => f.line), expected));
test('reads both READMEs and nested Markdown docs', () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-todos-'));
  try {
    mkdirSync(join(root, 'docs', 'nested'), { recursive: true });
    for (const file of ['README.md', 'README.en.md', 'docs/nested/guide.md']) writeFileSync(join(root, file), 'TODO: finish');
    writeFileSync(join(root, 'docs', 'example.txt'), 'TODO: ignored');
    assert.deepEqual(checkDocs(root).map(f => f.path), ['README.en.md', 'README.md', 'docs/nested/guide.md']);
    rmSync(join(root, 'README.md')); assert.throws(() => checkDocs(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
