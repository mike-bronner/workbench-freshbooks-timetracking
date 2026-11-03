import { setTimeout as delay } from 'node:timers/promises';

import { ACCESS_TOKEN, CLIENT_SECRET, REFRESH_TOKEN } from './keychain.mjs';

export const AUTHORIZE_URL = 'https://auth.freshbooks.com/oauth/authorize/';
export const REQUIRED_SCOPES = Object.freeze([
  'user:profile:read',
  'user:projects:read',
  'user:clients:read',
  'user:billable_items:read',
  'user:time_entries:read',
  'user:time_entries:write',
]);
export const PER_PAGE = 100;

const MAX_PAGES = 500;
const MAX_429_RETRIES = 5;
const MAX_BACKOFF_SECONDS = 60;
const EXPIRY_SKEW_MS = 60000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function apiBase() {
  const base = (process.env.WBFT_FRESHBOOKS_API || 'https://api.freshbooks.com').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error('WBFT_FRESHBOOKS_API is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('WBFT_FRESHBOOKS_API must use https unless its host is loopback');
  }
  return base;
}

export class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

const snippet = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat ? `: ${flat.slice(0, 300)}` : '';
};

async function tokenError(res) {
  const body = await res.json().catch(() => null);
  const code = typeof body?.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? ` ${body.error}` : '';
  return new ApiError(`freshbooks: the token endpoint answered HTTP ${res.status}${code}`, res.status);
}

export async function requestTokens(params, { fetch = globalThis.fetch, base = apiBase(), now = Date.now } = {}) {
  let res;
  try {
    res = await fetch(`${base}/auth/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (error) {
    throw new ApiError(`freshbooks: cannot reach the token endpoint: ${error.message}`);
  }
  if (!res.ok) throw await tokenError(res);
  const body = await res.json().catch(() => null);
  const valid = typeof body?.access_token === 'string' && body.access_token
    && typeof body.refresh_token === 'string' && body.refresh_token
    && Number(body.expires_in) > 0;
  if (!valid) throw new ApiError('freshbooks: the token response lacks access_token, refresh_token or expires_in');
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: now() + Number(body.expires_in) * 1000 - EXPIRY_SKEW_MS,
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

export function saveTokens(keychain, tokens) {
  keychain.set(REFRESH_TOKEN, tokens.refresh);
  keychain.set(ACCESS_TOKEN, JSON.stringify({ token: tokens.access, expires_at: tokens.expiresAt }));
}

const storedAccess = (text) => {
  try {
    const value = JSON.parse(text);
    return typeof value?.token === 'string' && Number.isFinite(value.expires_at) ? value : null;
  } catch {
    return null;
  }
};

const backoffSeconds = (res, attempt) => {
  const header = res.headers.get('retry-after');
  const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : 2 ** attempt;
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
};

export function createClient({ settings, keychain, fetch = globalThis.fetch, base = apiBase(), sleep = delay, now = Date.now }) {
  let access = null;
  let pending = null;

  const rotate = async () => {
    access = null;
    const refreshToken = keychain.get(REFRESH_TOKEN);
    const secret = keychain.get(CLIENT_SECRET);
    if (!refreshToken || !secret) throw new ApiError('freshbooks: not logged in; run bin/login.sh');
    if (!settings.client_id) throw new ApiError('config: set freshbooks.client_id');
    const tokens = await requestTokens({
      grant_type: 'refresh_token',
      client_id: settings.client_id,
      client_secret: secret,
      redirect_uri: settings.redirect_uri,
      refresh_token: refreshToken,
    }, { fetch, base, now });
    saveTokens(keychain, tokens);
    access = tokens.access;
    return access;
  };

  const refresh = (stale) => {
    if (access && access !== stale) return Promise.resolve(access);
    pending ??= rotate().finally(() => {
      pending = null;
    });
    return pending;
  };

  const current = async () => {
    if (access) return access;
    const stored = storedAccess(keychain.get(ACCESS_TOKEN));
    if (stored && stored.expires_at > now()) {
      access = stored.token;
      return access;
    }
    return refresh(null);
  };

  const request = async (method, path, body) => {
    let token = await current();
    let refreshed = false;
    let throttled = 0;
    for (;;) {
      const headers = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (error) {
        throw new ApiError(`freshbooks: ${method} ${path} failed: ${error.message}`);
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await refresh(token);
        continue;
      }
      if (res.status === 429 && throttled < MAX_429_RETRIES) {
        await sleep(backoffSeconds(res, throttled++) * 1000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new ApiError(`freshbooks: ${method} ${path} answered HTTP ${res.status}${snippet(text)}`, res.status);
      try {
        return JSON.parse(text);
      } catch {
        throw new ApiError(`freshbooks: ${method} ${path} returned a body that is not JSON`, res.status);
      }
    }
  };

  return { request };
}

const query = (params) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

async function collect(client, path, params, pick) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { list, pages } = pick(await client.request('GET', `${path}?${query({ ...params, page, per_page: PER_PAGE })}`));
    if (!Array.isArray(list)) throw new ApiError(`freshbooks: GET ${path} returned an unexpected shape`);
    items.push(...list);
    if (Number.isInteger(pages) ? page >= pages : list.length < PER_PAGE) return items;
  }
  throw new ApiError(`freshbooks: GET ${path} has more than ${MAX_PAGES} pages`);
}

const listOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : value);

export const listClients = (client, accountId) => collect(client, `/accounting/account/${encodeURIComponent(accountId)}/users/clients`,
  { 'search[vis_state]': 0 }, (body) => ({ list: body?.response?.result?.clients, pages: body?.response?.result?.pages }));

export const listProjects = (client, businessId) => collect(client, `/projects/business/${businessId}/projects`, {},
  (body) => ({ list: body?.projects, pages: body?.meta?.pages }));

export const listServices = (client, businessId) => collect(client, `/comments/business/${businessId}/services`, {},
  (body) => ({ list: listOf(body?.services), pages: body?.meta?.pages }));

export const listTimeEntries = (client, businessId, from, to) => collect(client, `/timetracking/business/${businessId}/time_entries`,
  { started_from: from, started_to: to }, (body) => ({ list: body?.time_entries, pages: body?.meta?.pages }));

export const createTimeEntry = (client, businessId, timeEntry) =>
  client.request('POST', `/timetracking/business/${businessId}/time_entries`, { time_entry: timeEntry });

export function pickBusiness(me, wanted = null) {
  const memberships = me?.response?.business_memberships ?? me?.business_memberships;
  const businesses = (Array.isArray(memberships) ? memberships : [])
    .map((m) => m?.business)
    .filter((b) => Number.isInteger(b?.id) && b.id > 0 && typeof b.account_id === 'string' && b.account_id);
  if (businesses.length === 0) throw new ApiError('freshbooks: this login has no business with an accounting account');
  const match = wanted === null ? (businesses.length === 1 ? businesses[0] : null) : businesses.find((b) => b.id === wanted);
  if (!match) {
    const known = businesses.map((b) => `${b.id} (${b.name ?? 'unnamed'})`).join(', ');
    throw new ApiError(wanted === null
      ? `freshbooks: this login has several businesses: ${known}; set freshbooks.business_id in config`
      : `freshbooks: business ${wanted} is not one of this login's businesses: ${known}`);
  }
  return { business_id: match.id, account_id: match.account_id, name: match.name ?? null };
}

export function missingScopes(scope) {
  if (scope === null) return [];
  const granted = new Set(scope.split(/\s+/));
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}
