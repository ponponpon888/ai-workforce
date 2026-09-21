// Real Git against a loopback-only HTTP 401 server; no external credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkPullAuthentication(target = 'node', pwshExe = 'pwsh', feature = false) {
  const root = mkdtempSync(join(tmpdir(), 'aiwf-auth-'));
  const repos = join(root, 'repos');
  const repo = join(repos, 'expired-auth');
  const observation = join(root, 'helper.jsonl');
  const config = join(root, 'empty.gitconfig');
  mkdirSync(repo, { recursive: true });
  writeFileSync(config, '');
  // Exclude inherited Git overrides, helpers, tracing and proxy configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(GIT_|GCM_|SSH_ASKPASS|.*_PROXY$)/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'always',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
    LC_ALL: 'C', LANG: 'C',
  });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr || String(r.error));
    return r.stdout.trim();
  };
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"', Connection: 'close' });
    response.end('Authentication required');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    git('init', '--initial-branch=main');
    writeFileSync(join(repo, 'work.txt'), 'keep this commit\n');
    git('add', 'work.txt');
    git('commit', '-m', 'fixture');
    git('remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);
    git('config', 'branch.main.remote', 'origin');
    git('config', 'branch.main.merge', 'refs/heads/main');
    git('config', 'http.proxy', '');
    git('config', 'credential.helper', '');
    const helper = join(root, 'observe-helper.mjs');
    writeFileSync(helper, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(observation)}, JSON.stringify({terminal:process.env.GIT_TERMINAL_PROMPT,manager:process.env.GCM_INTERACTIVE,operation:process.argv[2]})+'\\n');
process.stdin.resume();
`);
    // Git runs ! helpers through its shell, including Git for Windows' sh.
    const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
    git('config', '--add', 'credential.helper', `!${quote(process.execPath)} ${quote(helper)}`);
    if (feature) git('checkout', '-b', 'feat/auth');
    const before = git('rev-parse', 'HEAD');
    const mainBefore = git('rev-parse', 'main');
    const here = dirname(fileURLToPath(import.meta.url));
    const [executable, args] = target === 'ps'
      ? [pwshExe, ['-NoProfile', '-File', join(here, 'pull-all.ps1'), '-Root', repos]]
      : target === 'sh'
        ? ['sh', [join(here, 'pull-all.sh'), '--root', repos, '--quiet']]
        : [process.execPath, [join(here, 'pull-all.mjs'), '--root', repos, '--quiet']];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        server.closeAllConnections();
        child.kill('SIGKILL');
      }, 15000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
    });
    assert.equal(result.timedOut, false, 'credential failure must finish within 15 seconds');
    assert.equal(result.code, 1, result.output);
    assert.ok(requests > 0, 'real Git must reach the HTTP authentication challenge');
    const observed = readFileSync(observation, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(observed.some(entry => entry.operation === 'get'), 'Git must invoke the credential helper');
    assert.ok(observed.every(entry => entry.terminal === '0' && entry.manager === 'never'),
      'the running Git helper must inherit both noninteractive settings');
    const logs = readdirSync(join(repos, '_logs')).map(name => readFileSync(join(repos, '_logs', name), 'utf8')).join('\n');
    assert.match(logs, /terminal prompts disabled/i);
    assert.match(logs, feature ? /expired-auth\s+fail\/fetch/ : /expired-auth\s+fail\/pull/);
    assert.equal(git('rev-parse', 'main'), mainBefore);
    assert.equal(git('branch', '--show-current'), feature ? 'feat/auth' : 'main');
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(readFileSync(join(repo, 'work.txt'), 'utf8'), 'keep this commit\n');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}
