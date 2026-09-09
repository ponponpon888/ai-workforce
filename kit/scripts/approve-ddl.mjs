#!/usr/bin/env node
/**
 * approve-ddl.mjs — Approve one exact SQL statement so guard-sql will let it
 * through once.
 *
 * Run this yourself, after reading the SQL. It writes a token named after the
 * SHA-256 of the exact UTF-8 statement (v2 domain). The hook consumes the token on
 * first use and refuses it after the TTL, so an approval cannot be reused later
 * for a statement you never saw.
 *
 * Usage:
 *   node approve-ddl.mjs "alter table bookings add column memo text"
 *   node approve-ddl.mjs --file ./supabase/migrations/20260906_add_memo.sql
 *   node approve-ddl.mjs --force "..."     # skip the prompt (scripted pipelines only)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const APPROVAL_DIR =
  process.env.AIWF_APPROVAL_DIR || join(homedir(), '.claude', 'approvals');

const args = process.argv.slice(2);
const force = args.includes('--force');
const fileIdx = args.indexOf('--file');

let sql;
if (fileIdx !== -1) {
  const path = args[fileIdx + 1];
  if (!path) fail('--file needs a path.');
  sql = readFileSync(path, 'utf8');
} else {
  sql = args.filter((a) => a !== '--force').join(' ');
}

if (!sql || !sql.trim()) fail('Empty SQL.');

const digest = createHash('sha256').update('aiwf-exact-v2\0' + sql, 'utf8').digest('hex');

console.log('');
console.log('--- SQL to approve -------------------------------------------');
console.log(sql);
console.log('--------------------------------------------------------------');
console.log(`fingerprint : ${digest}`);
console.log('valid for   : 15 minutes, single use');
console.log('');

if (!force) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Approve this exact statement? (y/N) ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Cancelled. Nothing written.');
    process.exit(1);
  }
}

mkdirSync(APPROVAL_DIR, { recursive: true });
const file = join(APPROVAL_DIR, `${digest}.approval`);
writeFileSync(file, sql, 'utf8');

console.log('Approved. Retry the tool call unchanged.');
console.log(`token: ${file}`);

function fail(msg) {
  process.stderr.write(`approve-ddl: ${msg}\n`);
  process.exit(1);
}
