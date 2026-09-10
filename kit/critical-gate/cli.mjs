#!/usr/bin/env node
/** Offline sandbox only. Never executes the SQL or calls external services. */
import { readFileSync, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { TextDecoder } from 'node:util';
import { LocalApprovalStore } from './local-store.mjs';
import { GateError, requireGate, MAX_BYTES } from './protocol.mjs';

try {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  const allowed = { request: ['store', 'file'], review: ['store', 'id'], approve: ['store', 'id'], status: ['store', 'id'] };
  requireGate(Object.hasOwn(allowed, command), 'UNKNOWN_COMMAND');
  const options = Object.create(null);
  for (let i = 0; i < rest.length; i += 2) {
    requireGate(rest[i].startsWith('--') && typeof rest[i + 1] === 'string' && !rest[i + 1].startsWith('--'), 'INVALID_ARGUMENTS');
    const key = rest[i].slice(2);
    requireGate(allowed[command].includes(key) && !Object.hasOwn(options, key), 'UNKNOWN_OR_DUPLICATE_OPTION');
    options[key] = rest[i + 1];
  }
  requireGate(allowed[command].every(key => Object.hasOwn(options, key)), 'MISSING_OPTION');
  const store = new LocalApprovalStore(options.store);
  let output;
  if (command === 'request') {
    const stat = lstatSync(options.file);
    requireGate(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'INVALID_INPUT_FILE');
    const bytes = readFileSync(options.file);
    requireGate(bytes.length <= MAX_BYTES, 'INVALID_INPUT_FILE');
    const action = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const request = store.request(action);
    output = { id: request.id, state: 'pending', externalExecutionPerformed: false };
  } else if (command === 'approve') {
    const review = store.review(options.id);
    process.stdout.write('OFFLINE SANDBOX. Not identity verification or production authorization.\n');
    // JSON escaping prevents terminal-control sequences from concealing content.
    process.stdout.write(JSON.stringify(review, null, 2) + '\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await rl.question('Type the complete confirmation text: '); }
    finally { rl.close(); }
    output = store.approve(options.id, answer);
  } else {
    output = command === 'review' ? store.review(options.id) : store.status(options.id);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} catch (err) {
  // Do not echo SQL, credentials, absolute paths, or arbitrary exception strings.
  const code = err instanceof GateError ? err.code : 'LOCAL_GATE_ERROR';
  process.stderr.write(`[critical-gate] ${code}\n`);
  process.exitCode = 2;
}
