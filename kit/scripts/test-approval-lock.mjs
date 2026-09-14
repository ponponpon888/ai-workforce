// Called by test-sql-boundaries.mjs so existing Node/PowerShell CI runs it too.
// Only isolated hook processes and temporary tokens; never executes SQL.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function testApprovalLock({ exe, hook, hookArgs, ps, temp, approvals, env, payload, call, token }) {
  let pass = 0, fail = 0;
  async function check(name, fn) {
    try { await fn(); pass++; console.log('PASS ' + name); }
    catch (error) { fail++; console.log('FAIL ' + name + ': ' + error.message); }
  }
  const run = (sql, args = hookArgs) => spawnSync(exe, args, {
    input: payload(sql), encoding: 'utf8', env, timeout: 15000,
  });
  const lockFor = sql => token(sql) + '.lock';
  const assertBlocked = sql => {
    const result = run(sql);
    assert.equal(result.status, 2, result.stderr || String(result.error));
    assert.match(result.stderr, /approval-state-unavailable/);
    assert.doesNotMatch(result.stderr, /ask them to run/);
  };

  await check('empty lock blocks without consuming the approval', () => {
    const sql = 'CREATE TABLE lock_empty (id int)';
    const lock = lockFor(sql);
    writeFileSync(lock, '');
    assertBlocked(sql);
    assert.equal(readFileSync(lock.slice(0, -5), 'utf8'), sql);
    assert.equal(readFileSync(lock, 'utf8'), '');
  });
  await check('lock age never reactivates an approval', () => {
    const sql = 'CREATE TABLE lock_old (id int)';
    const lock = lockFor(sql);
    writeFileSync(lock, 'old lock');
    utimesSync(lock, new Date(0), new Date(0));
    assertBlocked(sql);
    assertBlocked(sql);
    assert.equal(readFileSync(lock, 'utf8'), 'old lock');
  });
  await check('malformed lock metadata is not treated as unlocked', () => {
    const sql = 'CREATE TABLE lock_invalid (id int)';
    const lock = lockFor(sql);
    writeFileSync(lock, '{');
    assertBlocked(sql);
    assert.equal(readFileSync(lock, 'utf8'), '{');
  });
  await check('directory at lock path blocks and is not removed', () => {
    const sql = 'CREATE TABLE lock_directory (id int)';
    const lock = lockFor(sql);
    mkdirSync(lock);
    assertBlocked(sql);
    assert.ok(existsSync(lock));
  });
  await check('an unrelated fingerprint is not blocked by another lock', () => {
    const sql = 'CREATE TABLE lock_independent (id int)';
    token(sql);
    assert.equal(call(sql), 0);
    assert.equal(call(sql), 2);
  });
  await check('normal completion releases only its own lock for a fresh approval', () => {
    const sql = 'CREATE TABLE lock_reissue (id int)';
    const file = token(sql);
    assert.equal(call(sql), 0);
    assert.ok(!existsSync(file));
    assert.ok(!existsSync(file + '.lock'));
    token(sql);
    assert.equal(call(sql), 0);
    assert.equal(call(sql), 2);
    assert.ok(!existsSync(file + '.lock'));
  });
  await check('missing approval does not leave a new sticky lock', () => {
    const sql = 'CREATE TABLE lock_missing (id int)';
    assert.equal(call(sql), 2);
    assert.equal(call(sql), 2);
    const file = token(sql);
    assert.ok(!existsSync(file + '.lock'));
    assert.equal(call(sql), 0);
  });

  // Instrument a temporary COPY, not the installed hook. There are no production
  // environment switches that can enable fault injection or bypass verification.
  const source = readFileSync(hook, 'utf8');
  const anchors = ps ? {
    acquire: '$lockStream = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
    rename: '[System.IO.File]::Move($file, $claimed)',
    consume: '[System.IO.File]::Delete($claimed)',
    flush: '$lockStream.Flush($true)',
  } : {
    acquire: "lockFd = openSync(lock, 'wx', 0o600);",
    rename: 'renameSync(file, claimed);',
    consume: 'unlinkSync(claimed);',
    flush: 'fsyncSync(lockFd);',
  };
  const fixture = (stage, crash) => {
    const anchor = anchors[stage];
    assert.equal(source.split(anchor).length, 2, 'unique checkpoint required: ' + stage);
    const pause = ps
      ? "\n        [Console]::Out.WriteLine('AIWF_LOCK_TEST_READY'); Start-Sleep -Seconds 60"
      : "\n    process.stdout.write('AIWF_LOCK_TEST_READY\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);";
    const failure = ps ? "throw 'injected IO failure'" : "throw new Error('injected IO failure');";
    const text = source.replace(anchor, () => crash ? anchor + pause : failure);
    const path = join(temp, `hook-${stage}-${crash ? 'crash' : 'error'}.${ps ? 'ps1' : 'mjs'}`);
    writeFileSync(path, text);
    return ps ? ['-NoProfile', '-File', path] : [path];
  };

  async function crashAt(args, sql) {
    const child = spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timer;
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('checkpoint timeout: ' + stderr)), 15000);
      child.once('error', reject);
      child.once('close', () => reject(new Error('hook closed before checkpoint: ' + stderr)));
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('AIWF_LOCK_TEST_READY')) resolve();
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload(sql));
    try {
      await ready;
      assert.ok(child.kill('SIGKILL'), 'test child must be terminated');
      const result = await closed;
      assert.notEqual(result.code, 0);
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      await closed;
    }
  }

  for (const stage of ['acquire', 'rename', 'consume']) {
    await check(`process death after ${stage} retains lock and forbids token revival`, async () => {
      const sql = `CREATE TABLE crash_${stage} (id int)`;
      const file = token(sql);
      await crashAt(fixture(stage, true), sql);
      assert.ok(existsSync(file + '.lock'));
      assert.equal(existsSync(file), stage === 'acquire');
      const used = readdirSync(approvals).filter(name => name.startsWith(file.split(/[\\/]/).at(-1) + '.used-'));
      assert.equal(used.length, stage === 'rename' ? 1 : 0);
      // Simulated accidental reissuance cannot bypass a crash lock, even when old.
      token(sql);
      utimesSync(file + '.lock', new Date(0), new Date(0));
      assertBlocked(sql);
      assertBlocked(sql);
      assert.ok(existsSync(file + '.lock'));
    });
  }
  for (const stage of ['flush', 'rename', 'consume']) {
    await check(`IO failure at ${stage} blocks and preserves recovery evidence`, () => {
      const sql = `CREATE TABLE io_${stage} (id int)`;
      const file = token(sql);
      const result = run(sql, fixture(stage, false));
      assert.equal(result.status, 2, result.stderr || String(result.error));
      assert.match(result.stderr, /approval-state-unavailable/);
      assert.ok(existsSync(file + '.lock'));
      token(sql);
      assertBlocked(sql);
    });
  }

  // Same SQL is deliberately reused between fully joined rounds. No live worker
  // remains when the next, separately issued temporary approval is created.
  for (const mixed of (ps ? [false, true] : [false])) {
  await check(`${mixed ? 'mixed Node/PowerShell' : 'repeated'} six-process contention grants exactly one call per approval`, async () => {
    const rounds = Number(process.env.AIWF_APPROVAL_STRESS_ROUNDS ?? '8');
    assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 200, 'stress rounds must be 1..200');
    const sql = `CREATE TABLE lock_stress_${mixed ? 'mixed' : 'single'} (id int)`;
    for (let round = 0; round < rounds; round++) {
      token(sql);
      const workers = Array.from({ length: 6 }, (_, index) => {
        const useNode = mixed && index % 2 === 0;
        const child = spawn(useNode ? process.execPath : exe, useNode ? [hook.replace(/\.ps1$/, '.mjs')] : hookArgs, { env, stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '', error;
        const ready = new Promise(resolve => {
          child.once('spawn', resolve);
          child.once('error', err => { error = err; resolve(); });
        });
        const done = new Promise(resolve => {
          const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
          child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stderr, error }); });
        });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdin.on('error', () => {});
        return { child, ready, done };
      });
      await Promise.all(workers.map(worker => worker.ready));
      for (const { child } of workers) child.stdin.end(payload(sql));
      const results = await Promise.all(workers.map(worker => worker.done));
      assert.equal(results.filter(result => result.code === 0).length, 1, `round ${round}: ${JSON.stringify(results)}`);
      assert.equal(results.filter(result => result.code === 2).length, 5, `round ${round}: ${JSON.stringify(results)}`);
    }
    console.log(`  contention rounds: ${rounds}, workers per round: 6`);
  });
  }
  return { pass, fail };
}
