import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTHORIZE_URL, ApiError, apiBase, createClient, missingScopes, pickBusiness, requestTokens, saveTokens } from './api.mjs';
import { CLIENT_SECRET } from './keychain.mjs';

const CODE_LIFETIME_MS = 5 * 60000;
export const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'wbft-cert-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } catch (error) {
    throw new Error(`login: cannot make a self-signed certificate with openssl: ${error.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sameState = (got, want) => {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

const reply = (res, status, text) => res.writeHead(status, { 'Content-Type': 'text/plain', Connection: 'close' }).end(`${text}\n`);

export function waitForCode({ redirectUri, state, cert, timeoutMs = CODE_LIFETIME_MS, onListening, log }) {
  const uri = new URL(redirectUri);
  if (!LOOPBACK.has(uri.hostname)) {
    throw new Error(`login: the redirect URI host ${uri.hostname} is not localhost or 127.0.0.1, so no local listener can catch it`);
  }
  return new Promise((resolve, reject) => {
    let timer;
    const server = createServer(cert, (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== uri.pathname) return reply(res, 404, 'Not found.');
      if (!sameState(url.searchParams.get('state') ?? '', state)) {
        log('login: rejected a callback whose state does not match');
        return reply(res, 400, 'The state does not match this login. The request was rejected.');
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        reply(res, 400, 'FreshBooks did not grant access.');
        const reason = /^[a-z_]{1,40}$/.test(error ?? '') ? error : 'no code';
        return finish(new Error(`login: FreshBooks did not grant access (${reason})`));
      }
      reply(res, 200, 'FreshBooks login received. You can close this tab.');
      return finish(null, code);
    });
    const finish = (error, code) => {
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(code);
    };
    timer = setTimeout(() => finish(new Error('login: no callback arrived within 5 minutes; run login again')), timeoutMs);
    server.on('error', (error) => finish(new Error(`login: cannot listen on ${uri.host}: ${error.message}`)));
    server.listen(Number(uri.port || 443), uri.hostname, onListening);
  });
}

export async function login({ settings, keychain, fetch = globalThis.fetch, base = apiBase(), open, log, makeCert = selfSignedCert }) {
  if (!settings.client_id) throw new Error('config: set freshbooks.client_id to the app\'s client id');
  const secret = keychain.get(CLIENT_SECRET);
  if (!secret) throw new Error('login: no client_secret in the keychain; run bin/store-secret.sh in a terminal first');
  const state = randomBytes(24).toString('hex');
  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: settings.client_id, redirect_uri: settings.redirect_uri, state,
  }).toString();
  const code = await waitForCode({
    redirectUri: settings.redirect_uri,
    state,
    cert: makeCert(),
    log,
    onListening: () => {
      log(`Open this URL to approve the app (the browser warns once about the local certificate):\n${authorize.href}`);
      open(authorize.href);
    },
  });
  const tokens = await requestTokens({
    grant_type: 'authorization_code',
    client_id: settings.client_id,
    client_secret: secret,
    code,
    redirect_uri: settings.redirect_uri,
  }, { fetch, base });
  saveTokens(keychain, tokens);
  const missing = missingScopes(tokens.scope);
  if (missing.length) throw new ApiError(`login: the app lacks the scopes ${missing.join(', ')}; add them in the FreshBooks developer portal and log in again`);
  const client = createClient({ settings, keychain, fetch, base });
  return pickBusiness(await client.request('GET', '/auth/api/v1/users/me'), settings.business_id);
}
