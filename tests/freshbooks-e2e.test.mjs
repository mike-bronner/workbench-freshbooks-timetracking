import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ACCESS_TOKEN, CLIENT_SECRET as SECRET_ACCOUNT, REFRESH_TOKEN, SERVICE } from '../lib/freshbooks/keychain.mjs';
import { BUSINESS, CLIENT_ID, CLIENT_SECRET, fakeFreshbooks } from './lib/fake-freshbooks.mjs';
import { TZ, at, config, sandbox } from './lib/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_SECURITY = join(ROOT, 'tests', 'lib', 'fake-security.mjs');

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const callback = (url) => new Promise((resolve, reject) => {
  get(url, { rejectUnauthorized: false }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  }).on('error', reject);
});

function launch(script, args, env) {
  const child = spawn('bash', [join(ROOT, 'bin', script), ...args], { env: { ...process.env, ...env } });
  const result = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { result.stdout += d; });
  child.stderr.on('data', (d) => { result.stderr += d; });
  result.done = new Promise((resolve) => child.on('close', (code) => resolve({ ...result, code })));
  result.waitFor = async (pattern) => {
    for (let i = 0; i < 200 && !pattern.test(result.stderr); i++) await new Promise((r) => setTimeout(r, 25));
    return pattern.exec(result.stderr);
  };
  return result;
}

describe('freshbooks scripts', () => {
  let box;
  let server;
  let env;
  let store;
  let configPath;
  let redirectUri;

  const keychainItems = () => JSON.parse(readFileSync(store, 'utf8'));
  const writeKeychain = (items) => writeFileSync(store, JSON.stringify(Object.fromEntries(Object.entries(items).map(([k, v]) => [`${SERVICE}/${k}`, v]))));

  beforeEach(async () => {
    box = sandbox();
    redirectUri = `https://localhost:${await freePort()}/callback`;
    server = await fakeFreshbooks({ redirectUri });
    store = join(box.root, 'keychain.json');
    configPath = join(box.root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ ...config(), freshbooks: { client_id: CLIENT_ID, redirect_uri: redirectUri } }));
    writeKeychain({ [SECRET_ACCOUNT]: CLIENT_SECRET });
    env = { WBFT_SECURITY: FAKE_SECURITY, WBFT_FAKE_KEYCHAIN: store, WBFT_FRESHBOOKS_API: server.url, WBFT_CONFIG: configPath };
  });

  afterEach(async () => {
    await server.close();
    box.cleanup();
  });

  const secrets = () => [CLIENT_SECRET, ...server.state.issued.flatMap((t) => [t.access_token, t.refresh_token])];
  const assertNoSecret = (text, where) => {
    for (const secret of secrets()) {
      assert.ok(!text.includes(secret), `${where} carries a secret`);
      assert.ok(!text.includes(Buffer.from(secret).toString('hex')), `${where} carries a secret as hex`);
    }
  };

  it('logs in through a local HTTPS listener, rejecting a mismatched state', async () => {
    const run = launch('login.sh', ['--no-open'], env);
    const [, url] = await run.waitFor(/(https:\/\/auth\.freshbooks\.com\/oauth\/authorize\/\?\S+)/);
    const authorize = new URL(url);
    assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(authorize.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    const state = authorize.searchParams.get('state');

    assert.equal(await callback(`${redirectUri}?code=${server.state.code}&state=${state}x`), 400);
    assert.equal(server.state.log.length, 0);
    assert.equal(await callback(`${redirectUri}?code=${server.state.code}&state=${state}`), 200);

    const { code, stdout, stderr } = await run.done;
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { logged_in: true, business_id: BUSINESS.id, account_id: BUSINESS.account_id, name: BUSINESS.name });
    assert.match(stderr, /rejected a callback whose state does not match/);
    assert.deepEqual(server.state.log.map((r) => [r.method, r.path]), [['POST', '/auth/oauth/token'], ['GET', '/auth/api/v1/users/me']]);
    assert.equal(server.state.log[0].body.code, server.state.code);
    const items = keychainItems();
    assert.equal(items[`${SERVICE}/${REFRESH_TOKEN}`], server.state.refresh);
    assert.equal(JSON.parse(items[`${SERVICE}/${ACCESS_TOKEN}`]).token, server.state.issued[0].access_token);
    const saved = readFileSync(configPath, 'utf8');
    assert.equal(JSON.parse(saved).freshbooks.business_id, BUSINESS.id);
    for (const [where, text] of [['stdout', stdout], ['stderr', stderr], ['config', saved], ['security arguments', readFileSync(`${store}.argv`, 'utf8')]]) {
      assertNoSecret(text, where);
    }
  });

  it('refuses to log in when the app lacks a required scope', async () => {
    server.state.scope = 'user:profile:read user:time_entries:read';
    const run = launch('login.sh', ['--no-open'], env);
    const [, url] = await run.waitFor(/(https:\/\/auth\.freshbooks\.com\S+)/);
    await callback(`${redirectUri}?code=${server.state.code}&state=${new URL(url).searchParams.get('state')}`);
    const { code, stderr } = await run.done;
    assert.equal(code, 1);
    assert.match(stderr, /lacks the scopes user:projects:read, user:clients:read, user:billable_items:read, user:time_entries:write/);
  });

  it('plans and pushes after a refresh without a secret in output, config or arguments', async () => {
    const tokens = server.state.seedTokens();
    writeKeychain({
      [SECRET_ACCOUNT]: CLIENT_SECRET,
      [REFRESH_TOKEN]: tokens.refresh,
      [ACCESS_TOKEN]: JSON.stringify({ token: tokens.access, expires_at: Date.now() - 1 }),
    });
    writeFileSync(configPath, JSON.stringify({
      ...config(),
      freshbooks: { client_id: CLIENT_ID, redirect_uri: redirectUri, business_id: 77, account_id: 'acct9', repos: { 'acme/widgets': { client_id: 5, project_id: 40, service_id: 9 } } },
    }));
    const lines = join(box.root, 'lines.json');
    writeFileSync(lines, JSON.stringify({
      range: { from: '2026-10-14', to: '2026-10-14', timezone: TZ },
      repos: [{ repo: 'acme/widgets', lines: [{ repo: 'acme/widgets', date: '2026-10-14', kind: 'general', label: 'General development', billable_hours: 0.5, first_work: at('2026-10-14 09:00:00'), tag: '[wbi:acme/widgets:2026-10-14]' }] }],
    }));

    const plan = await launch('plan.sh', ['--lines', lines, '--format', 'table'], env).done;
    assert.equal(plan.code, 0, plan.stderr);
    const [, approval] = /Approval code: (\w+)/.exec(plan.stdout);
    const pushed = await launch('push.sh', ['--lines', lines, '--approve', approval], env).done;
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.equal(JSON.parse(pushed.stdout).created.length, 1);
    assert.equal(server.state.issued.length, 2);
    assert.equal(keychainItems()[`${SERVICE}/${REFRESH_TOKEN}`], server.state.refresh);

    const argv = readFileSync(`${store}.argv`, 'utf8');
    for (const [where, text] of [['plan output', plan.stdout + plan.stderr], ['push output', pushed.stdout + pushed.stderr], ['config', readFileSync(configPath, 'utf8')], ['security arguments', argv]]) {
      assertNoSecret(text, where);
    }
  });

  it('stores the client_secret from stdin without echoing it', async () => {
    const child = spawn('bash', [join(ROOT, 'bin', 'store-secret.sh')], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.end('piped-secret-31\n');
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0);
    assert.equal(keychainItems()[`${SERVICE}/${SECRET_ACCOUNT}`], 'piped-secret-31');
    assert.doesNotMatch(out + readFileSync(`${store}.argv`, 'utf8'), /piped-secret-31/);
  });

  describe('secret dialog', () => {
    const fakeOsascript = (body) => {
      const dir = join(box.root, 'fakebin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(box.root, 'osascript.args')}'\n${body}\n`, { mode: 0o755 });
      return { ...env, PATH: `${dir}:${process.env.PATH}` };
    };
    const runDialog = (dialogEnv) => {
      const child = spawn('bash', [join(ROOT, 'bin', 'store-secret.sh'), '--dialog'], { env: { ...process.env, ...dialogEnv } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.stdin.end();
      return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
    };

    it('takes the secret from a hidden macOS dialog straight to the keychain', async () => {
      const { code, out } = await runDialog(fakeOsascript("printf 'dialog-secret-58\\n'"));
      assert.equal(code, 0, out);
      assert.equal(keychainItems()[`${SERVICE}/${SECRET_ACCOUNT}`], 'dialog-secret-58');
      assert.match(readFileSync(join(box.root, 'osascript.args'), 'utf8'), /with hidden answer/);
      assert.doesNotMatch(out + readFileSync(`${store}.argv`, 'utf8'), /dialog-secret-58/);
    });

    it('saves nothing when the dialog is cancelled', async () => {
      const { code } = await runDialog(fakeOsascript("echo 'execution error: User canceled. (-128)' >&2\nexit 1"));
      assert.notEqual(code, 0);
      assert.equal(keychainItems()[`${SERVICE}/${SECRET_ACCOUNT}`], CLIENT_SECRET);
    });
  });

  it('creates the config from the example and reports the setup state through the scripts', async () => {
    const fresh = join(box.root, 'new', 'config.json');
    const created = await launch('init-config.sh', [], { ...env, WBFT_CONFIG: fresh }).done;
    assert.deepEqual(JSON.parse(created.stdout), { config_path: fresh, created: true });
    const configured = await launch('configure.sh', ['--client-id', CLIENT_ID], { ...env, WBFT_CONFIG: fresh }).done;
    assert.equal(configured.code, 0, configured.stderr);
    const status = JSON.parse((await launch('status.sh', [], { ...env, WBFT_CONFIG: fresh }).done).stdout);
    assert.deepEqual([status.config_exists, status.freshbooks.client_id, status.client_secret_saved, status.logged_in], [true, CLIENT_ID, true, false]);
  });
});
