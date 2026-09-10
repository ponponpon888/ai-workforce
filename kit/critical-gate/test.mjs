#!/usr/bin/env node
// Offline tests. SQL is data: neither database clients nor external APIs run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalApprovalStore } from './local-store.mjs';
import { actionHash, confirmationText, GateError, MAX_TTL_MS, MAX_BYTES } from './protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, 'example.sandbox.json'), 'utf8'));
const action = () => structuredClone(example);
const errorCode = code => err => err instanceof GateError && err.code === code;
const base = mkdtempSync(join(tmpdir(), 'aiwf-critical-tests-'));
let count = 0;
const roots = [];
function fresh(options) {
  const root = join(base, 'case-' + (++count));
  const store = new LocalApprovalStore(root, options);
  roots.push(root);
  return { root, store };
}
function approved(store, input = action(), opts) {
  const request = store.request(input, opts);
  store.approve(request.id, confirmationText(request));
  return request;
}
const claim = (store, request, input = request.action, revision = request.action.precondition.revision) =>
  store.claim(request.id, { expectedAction: input, currentRevision: revision });
function replace(root, section, id, fn) {
  const path = join(root, section, id + '.json');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  fn(value); writeFileSync(path, JSON.stringify(value));
}
const cli = (root, args, input = '') => spawnSync(process.execPath, [join(here, 'cli.mjs'), ...args, '--store', root],
  { input, encoding: 'utf8', timeout: 15000 });
const storeUrl = pathToFileURL(join(here, 'local-store.mjs')).href;
const worker = join(base, 'worker.mjs');
writeFileSync(worker, `import { LocalApprovalStore } from ${JSON.stringify(storeUrl)};
const store = new LocalApprovalStore(process.argv[2]);
process.once('message', ({ request }) => {
  try { store.claim(request.id, { expectedAction: request.action, currentRevision: request.action.precondition.revision }); process.exit(0); }
  catch { process.exit(2); }
});
process.send({ ready: true });
`);
function racer(root) {
  const child = fork(worker, [root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('worker timeout')); }, 15000);
    child.once('error', err => { clearTimeout(timeout); reject(err); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  const ready = new Promise((resolve, reject) => {
    child.once('message', msg => msg.ready ? resolve() : reject(new Error('invalid barrier')));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('worker exited before barrier')));
  });
  // Attach a handler immediately; a startup error must not leak an unhandled rejection.
  result.catch(() => {});
  return { child, ready, result };
}

try {
  await test('request is pending and review explicitly reports unverified boundaries', () => {
    const { store } = fresh(); const r = store.request(action());
    assert.equal(store.status(r.id).state, 'pending');
    const view = store.review(r.id);
    assert.equal(view.identityVerified, false); assert.equal(view.targetVerified, false);
    assert.equal(view.externalExecutionSupported, false);
    assert.match(view.confirmation, /^APPROVE /);
  });
  for (const answer of ['yes', 'YES', 'y', 'Y', 'OK', 'はい', '進めて', '', 'true']) {
    await test(`generic answer ${JSON.stringify(answer)} does not approve`, () => {
      const { store } = fresh(); const r = store.request(action());
      assert.throws(() => store.approve(r.id, answer), errorCode('CONFIRMATION_MISMATCH'));
      assert.equal(store.status(r.id).state, 'pending');
    });
  }
  await test('whitespace or casing changes do not match the exact phrase', () => {
    const { store } = fresh(); const r = store.request(action()); const phrase = confirmationText(r);
    for (const value of [' ' + phrase, phrase + ' ', phrase.toLowerCase()]) {
      assert.throws(() => store.approve(r.id, value), errorCode('CONFIRMATION_MISMATCH'));
    }
  });
  await test('approval is required before claim', () => {
    const { store } = fresh(); const r = store.request(action());
    assert.throws(() => claim(store, r), errorCode('RECORD_MISSING'));
  });
  await test('exact approval and exact action permit one claim only', () => {
    const { store } = fresh(); const r = approved(store);
    assert.equal(store.status(r.id).state, 'approved');
    const granted = claim(store, r);
    assert.deepEqual(granted.action, r.action); assert.equal(granted.externalExecutionPerformed, false);
    assert.equal(store.status(r.id).state, 'outcome-unknown');
    assert.throws(() => claim(store, r), errorCode('RECORD_EXISTS'));
    assert.throws(() => store.approve(r.id, confirmationText(r)), errorCode('ALREADY_CLAIMED'));
  });
  await test('double approval cannot replace the record', () => {
    const { root, store } = fresh(); const r = approved(store);
    const before = readFileSync(join(root, 'approvals', r.id + '.json'));
    assert.throws(() => store.approve(r.id, confirmationText(r)), errorCode('RECORD_EXISTS'));
    assert.deepEqual(readFileSync(join(root, 'approvals', r.id + '.json')), before);
  });
  for (const [label, mutate] of [
    ['project', a => { a.target.projectId = 'another-project'; }],
    ['tool', a => { a.toolName = 'mcp__Supabase__apply_migration'; }],
    ['SQL', a => { a.parameters.query += ' '; }],
    ['quoted whitespace', a => { a.parameters.query = "CREATE TABLE x (v text DEFAULT 'a  b')"; }],
    ['revision', a => { a.precondition.revision = 'revision-2'; }],
  ]) {
    await test(`changing ${label} cannot reuse an approval`, () => {
      const { store } = fresh(); const r = approved(store); const changed = action(); mutate(changed);
      assert.throws(() => claim(store, r, changed), errorCode('ACTION_MISMATCH'));
      assert.equal(store.status(r.id).state, 'approved');
    });
  }
  await test('observed revision mismatch stops before consuming', () => {
    const { store } = fresh(); const r = approved(store);
    assert.throws(() => claim(store, r, r.action, 'changed'), errorCode('PRECONDITION_CHANGED'));
    assert.equal(store.status(r.id).state, 'approved');
  });
  await test('property ordering is canonical, query byte changes are not', () => {
    const a = action(); const reversed = Object.fromEntries(Object.entries(a).reverse());
    reversed.target = Object.fromEntries(Object.entries(a.target).reverse());
    assert.equal(actionHash(a), actionHash(reversed));
    const b = action(); b.parameters.query += '\r\n'; assert.notEqual(actionHash(a), actionHash(b));
  });
  await test('literal whitespace and Unicode normalization remain distinct', () => {
    const a = action(); const b = action();
    a.parameters.query = "CREATE TABLE x (v text DEFAULT 'a  b')";
    b.parameters.query = "CREATE TABLE x (v text DEFAULT 'a b')";
    assert.notEqual(actionHash(a), actionHash(b));
    a.parameters.query = "CREATE TABLE x (v text DEFAULT '\u00e9')";
    b.parameters.query = "CREATE TABLE x (v text DEFAULT 'e\u0301')";
    assert.notEqual(actionHash(a), actionHash(b));
  });
  await test('input and returned objects cannot mutate the persisted request', () => {
    const { store } = fresh(); const input = action(); const r = store.request(input);
    input.target.projectId = 'mutated'; r.action.parameters.query = 'bad';
    assert.deepEqual(store.review(r.id).request.action, action());
  });
  for (const [label, mutate, code] of [
    ['production', a => { a.target.environment = 'production'; }, 'PRODUCTION_NOT_SUPPORTED'],
    ['unknown operation', a => { a.kind = 'shell'; }, 'UNSUPPORTED_ACTION'],
    ['unknown provider', a => { a.target.provider = 'other'; }, 'UNSUPPORTED_PROVIDER'],
    ['policy downgrade', a => { a.policyVersion = 'relaxed'; }, 'POLICY_MISMATCH'],
    ['extra parameter', a => { a.parameters.project_id = 'other'; }, 'INVALID_FIELDS'],
    ['extra target field', a => { a.target.url = 'other'; }, 'INVALID_FIELDS'],
    ['missing revision', a => { delete a.precondition; }, 'INVALID_FIELDS'],
    ['path/control project ID', a => { a.target.projectId = '../x\nAPPROVE'; }, 'INVALID_IDENTIFIER'],
    ['terminal escape', a => { a.parameters.query += '\u001b[2J'; }, 'CONTROL_CHARACTER'],
    ['unpaired surrogate', a => { a.parameters.query += '\ud800'; }, 'INVALID_UNICODE'],
    ['unbounded query', a => { a.parameters.query = 'CREATE ' + 'x'.repeat(MAX_BYTES); }, 'INVALID_TEXT'],
  ]) {
    await test(`reject ${label}`, () => {
      const { root, store } = fresh(); const input = action(); mutate(input);
      assert.throws(() => store.request(input), errorCode(code));
      assert.equal(readdirSync(join(root, 'requests')).length, 0);
    });
  }
  for (const query of ['DROP TABLE x', 'TRUNCATE x', 'DELETE FROM x WHERE id=1', 'UPDATE x SET id=2 WHERE id=1', 'DO $$ BEGIN END $$', 'CREATE TABLE x (id int); DROP TABLE y']) {
    await test(`hard-stop SQL fixture: ${query.slice(0, 25)}`, () => {
      const { store } = fresh(); const input = action(); input.parameters.query = query;
      assert.throws(() => store.request(input), errorCode('FORBIDDEN_SQL'));
    });
  }
  await test('expired approvals cannot claim, and approval never extends expiry', () => {
    let now = 100000; const { store } = fresh({ clock: () => now });
    const r = store.request(action(), { ttlMs: 10 }); now += 9;
    store.approve(r.id, confirmationText(r)); now++;
    assert.throws(() => claim(store, r), errorCode('EXPIRED'));
    assert.equal(store.status(r.id).state, 'expired');
  });
  await test('expired pending request cannot be approved', () => {
    let now = 100000; const { store } = fresh({ clock: () => now });
    const r = store.request(action(), { ttlMs: 10 }); now += 10;
    assert.throws(() => store.approve(r.id, confirmationText(r)), errorCode('EXPIRED'));
  });
  await test('clock rollback before creation stops approval', () => {
    let now = 100000; const { store } = fresh({ clock: () => now }); const r = store.request(action()); now--;
    assert.throws(() => store.approve(r.id, confirmationText(r)), errorCode('FUTURE_REQUEST'));
  });
  await test('invalid TTL values cannot create requests', () => {
    const { store } = fresh();
    for (const ttlMs of [0, -1, MAX_TTL_MS + 1, 1.5, Infinity, '100']) {
      assert.throws(() => store.request(action(), { ttlMs }), errorCode('INVALID_TTL'));
    }
  });
  await test('expiry occurring during claim burns the ID, never restores approval', () => {
    let now = 100000; const { root, store } = fresh({ clock: () => now });
    const r = approved(store, action(), { ttlMs: 10 });
    const other = new LocalApprovalStore(root, { clock: () => existsSync(join(root, 'claims', r.id + '.json')) ? 100010 : 100009 });
    assert.throws(() => claim(other, r), errorCode('EXPIRED'));
    now = 100010; assert.equal(store.status(r.id).state, 'outcome-unknown');
  });
  await test('request edits are rejected even when action hash is recomputed', () => {
    const { root, store } = fresh(); const r = approved(store);
    replace(root, 'requests', r.id, row => { row.action.target.projectId = 'edited'; row.actionHash = actionHash(row.action); });
    const edited = store.review(r.id).request;
    assert.throws(() => claim(store, edited), errorCode('APPROVAL_MISMATCH'));
  });
  await test('approval cannot move to another issuance with identical SQL', () => {
    const { root, store } = fresh(); const a = approved(store); const b = store.request(action());
    writeFileSync(join(root, 'approvals', b.id + '.json'), readFileSync(join(root, 'approvals', a.id + '.json')));
    assert.throws(() => claim(store, b), errorCode('APPROVAL_MISMATCH'));
  });
  for (const outcome of ['succeeded', 'failed']) {
    await test(`${outcome} is terminal and cannot reopen the approval`, () => {
      const { store } = fresh(); const r = approved(store); const { receipt } = claim(store, r);
      store.recordOutcome(receipt, outcome); assert.equal(store.status(r.id).state, outcome);
      assert.throws(() => claim(store, r), errorCode('RECORD_EXISTS'));
      assert.throws(() => store.recordOutcome(receipt, outcome), errorCode('RECORD_EXISTS'));
    });
  }
  await test('incorrect receipt cannot report success', () => {
    const { store } = fresh(); const r = approved(store); const { receipt } = claim(store, r);
    assert.throws(() => store.recordOutcome({ ...receipt, claimId: '0'.repeat(32) }, 'succeeded'), errorCode('RECEIPT_MISMATCH'));
    assert.equal(store.status(r.id).state, 'outcome-unknown');
  });
  await test('partial result remains unknown and cannot be overwritten', () => {
    const { root, store } = fresh(); const r = approved(store); const { receipt } = claim(store, r);
    writeFileSync(join(root, 'outcomes', r.id + '.json'), '{');
    assert.equal(store.status(r.id).state, 'outcome-unknown');
    assert.throws(() => store.recordOutcome(receipt, 'failed'), errorCode('RECORD_EXISTS'));
  });
  await test('expired or restarted consumed request stays outcome-unknown', () => {
    let now = 100000; const { root, store } = fresh({ clock: () => now });
    const r = approved(store); claim(store, r); now += MAX_TTL_MS;
    const reopened = new LocalApprovalStore(root, { clock: () => now });
    assert.equal(reopened.status(r.id).state, 'outcome-unknown');
  });
  await test('restoring a request/approval backup does not revive its claim ID', () => {
    const { root, store } = fresh(); const r = approved(store);
    const paths = ['requests', 'approvals'].map(s => join(root, s, r.id + '.json'));
    const backups = paths.map(p => readFileSync(p)); claim(store, r);
    paths.forEach((p, i) => writeFileSync(p, backups[i]));
    assert.throws(() => claim(new LocalApprovalStore(root), r), errorCode('RECORD_EXISTS'));
  });
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1, 32)]) {
    await test(`malformed request of ${bytes.length} bytes cannot become permission`, () => {
      const { root, store } = fresh(); const r = approved(store);
      writeFileSync(join(root, 'requests', r.id + '.json'), bytes);
      assert.throws(() => claim(store, r)); assert.equal(readdirSync(join(root, 'claims')).length, 0);
    });
  }
  await test('path traversal IDs are rejected', () => {
    const { store } = fresh();
    for (const id of ['../x', 'a/b', '', '0'.repeat(33), 'G'.repeat(32)]) assert.throws(() => store.review(id), errorCode('INVALID_ID'));
  });
  await test('legacy .approval files grant no new-protocol authority', () => {
    const { root, store } = fresh(); const r = store.request(action());
    writeFileSync(join(root, r.actionHash + '.approval'), r.action.parameters.query);
    assert.throws(() => claim(store, r), errorCode('RECORD_MISSING'));
  });
  await test('CLI rejects --force and unknown/duplicate options without creating the store', () => {
    for (const extra of [['--force'], ['--force', 'true'], ['--id', 'x', '--id', 'y']]) {
      const root = join(base, 'invalid-cli-' + (++count));
      const result = cli(root, ['approve', ...extra]); assert.equal(result.status, 2); assert.equal(existsSync(root), false);
    }
  });
  await test('CLI accepts explicit phrase but rejects a chat-style yes', () => {
    const { root, store } = fresh(); const r = store.request(action());
    const yes = cli(root, ['approve', '--id', r.id], 'yes\n');
    assert.equal(yes.status, 2); assert.equal(store.status(r.id).state, 'pending');
    const correct = cli(root, ['approve', '--id', r.id], confirmationText(r) + '\n');
    assert.equal(correct.status, 0, correct.stderr); assert.equal(store.status(r.id).state, 'approved');
  });
  await test('CLI has no claim/execute or outcome-forging command', () => {
    for (const command of ['claim', 'execute', 'record-outcome']) {
      const root = join(base, 'no-command-' + (++count));
      assert.equal(cli(root, [command]).status, 2); assert.equal(existsSync(root), false);
    }
  });
  await test('request CLI works with sandbox example and never executes it', () => {
    const { root } = fresh(); const result = cli(root, ['request', '--file', join(here, 'example.sandbox.json')]);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout); assert.equal(value.state, 'pending'); assert.equal(value.externalExecutionPerformed, false);
  });
  for (const stage of ['before-create', 'after-create', 'flush-failure', 'after-flush']) {
    await test(`fault injection: ${stage}`, () => {
      const { root, store } = fresh(); const r = approved(store);
      const injector = join(base, `inject-${stage}.mjs`);
      writeFileSync(injector, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync, flush = fs.fsyncSync; const claimed = new Set();
fs.openSync = (path, ...args) => {
  const hit = String(path).replaceAll('\\\\','/').includes('/claims/');
  if (hit && ${JSON.stringify(stage)} === 'before-create') throw Object.assign(new Error('injected'), {code:'EIO'});
  const fd = open(path,...args);
  if(hit) { claimed.add(fd); if(${JSON.stringify(stage)} === 'after-create') process.exit(73); }
  return fd;
};
fs.fsyncSync = fd => {
  if (claimed.has(fd) && ${JSON.stringify(stage)} === 'flush-failure') throw Object.assign(new Error('injected'), {code:'EIO'});
  const result = flush(fd);
  if (claimed.has(fd) && ${JSON.stringify(stage)} === 'after-flush') process.exit(73);
  return result;
}; syncBuiltinESMExports();`);
      const run = join(base, 'claim-once.mjs');
      writeFileSync(run, `import { LocalApprovalStore } from ${JSON.stringify(storeUrl)};
import {readFileSync} from 'node:fs'; const request=JSON.parse(readFileSync(0,'utf8'));
try { new LocalApprovalStore(process.argv[2]).claim(request.id, {expectedAction:request.action,currentRevision:request.action.precondition.revision}); process.exitCode=0; }
catch { process.exitCode=2; }`);
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(injector).href, run, root],
        { input: JSON.stringify(r), encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, ['after-create', 'after-flush'].includes(stage) ? 73 : 2, result.stderr);
      if (stage === 'before-create') {
        assert.equal(store.status(r.id).state, 'approved'); assert.doesNotThrow(() => claim(store, r));
      } else {
        assert.equal(store.status(r.id).state, 'outcome-unknown');
        assert.throws(() => claim(new LocalApprovalStore(root), r), errorCode('RECORD_EXISTS'));
      }
    });
  }
  await test('six concurrent claimers have exactly one winner, repeated 40 rounds', { timeout: 120000 }, async () => {
    for (let round = 0; round < 40; round++) {
      const { root, store } = fresh(); const r = approved(store);
      const racers = Array.from({ length: 6 }, () => racer(root));
      try {
        await Promise.all(racers.map(x => x.ready));
        racers.forEach(x => x.child.send({ request: r }));
        const results = await Promise.all(racers.map(x => x.result));
        assert.equal(results.filter(x => x.code === 0).length, 1, `round ${round}: ${JSON.stringify(results)}`);
        assert.equal(results.filter(x => x.code === 2).length, 5, `round ${round}: ${JSON.stringify(results)}`);
        assert.equal(store.status(r.id).state, 'outcome-unknown');
      } finally { racers.forEach(x => { if (x.child.exitCode === null) x.child.kill(); }); }
    }
  });
  await test('symlinked record cannot authorize a claim', { skip: process.platform === 'win32' ? 'requires Windows symlink privilege; not counted as verified' : false }, () => {
    const { root, store } = fresh(); const r = approved(store);
    const record = join(root, 'approvals', r.id + '.json'); const copy = join(root, 'copy.json');
    writeFileSync(copy, readFileSync(record)); rmSync(record); symlinkSync(copy, record);
    assert.throws(() => claim(store, r), errorCode('UNSAFE_RECORD'));
  });
} finally {
  rmSync(base, { recursive: true, force: true });
}
