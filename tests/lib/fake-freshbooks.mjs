import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { REQUIRED_SCOPES } from '../../lib/freshbooks/api.mjs';

export const CLIENT_ID = 'client-abc';
export const CLIENT_SECRET = 'cs-SECRET-4f1d9a';
export const BUSINESS = { id: 77, account_id: 'acct9', name: 'Bronner LLC' };

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(body === undefined ? '' : JSON.stringify(body));
};

export async function fakeFreshbooks({ events = [], redirectUri = 'https://localhost:8443' } = {}) {
  const state = {
    redirectUri,
    code: 'auth-code-1',
    codeUsed: false,
    refresh: null,
    access: new Set(),
    issued: [],
    scope: REQUIRED_SCOPES.join(' '),
    me: { response: { business_memberships: [{ role: 'owner', business: BUSINESS }] } },
    clients: [{ id: 5, organization: 'Acme Corp', email: 'ap@acme.test', vis_state: 0 }, { id: 6, fname: 'Jo', lname: 'Doe', email: '' }],
    projects: [{ id: 40, title: 'Widgets', client_id: 5, services: [{ id: 9 }] }, { id: 41, title: 'Other', client_id: 6, services: [] }],
    services: [{ id: 9, name: 'Development', vis_state: 0 }, { id: 10, name: 'Old', vis_state: 1 }],
    entries: [],
    nextId: 1000,
    failures: [],
    omitPages: false,
    log: [],
  };

  const issue = () => {
    const n = state.issued.length + 1;
    const tokens = { access_token: `access-TOKEN-${n}-${randomBytes(6).toString('hex')}`, refresh_token: `refresh-TOKEN-${n}-${randomBytes(6).toString('hex')}` };
    state.issued.push(tokens);
    state.access = new Set([tokens.access_token]);
    state.refresh = tokens.refresh_token;
    return { ...tokens, token_type: 'Bearer', expires_in: 43200, scope: state.scope };
  };

  state.seedTokens = () => {
    const tokens = issue();
    return { refresh: tokens.refresh_token, access: tokens.access_token };
  };

  const token = (body, res) => {
    const known = body.client_id === CLIENT_ID && body.client_secret === CLIENT_SECRET && body.redirect_uri === state.redirectUri;
    if (known && body.grant_type === 'authorization_code' && body.code === state.code && !state.codeUsed) {
      state.codeUsed = true;
      return send(res, 200, issue());
    }
    if (known && body.grant_type === 'refresh_token' && body.refresh_token === state.refresh) return send(res, 200, issue());
    return send(res, 400, { error: 'invalid_grant' });
  };

  const page = (list, url) => {
    const per = Math.min(Number(url.searchParams.get('per_page') ?? 15), 100);
    const n = Number(url.searchParams.get('page') ?? 1);
    const pages = Math.max(1, Math.ceil(list.length / per));
    return { items: list.slice((n - 1) * per, n * per), meta: { page: n, pages, per_page: per, total: list.length } };
  };

  const routes = [
    ['GET', /^\/auth\/api\/v1\/users\/me$/, () => [200, state.me]],
    ['GET', /^\/accounting\/account\/acct9\/users\/clients$/, (url) => {
      const { items, meta } = page(state.clients, url);
      return [200, { response: { result: { clients: items, page: meta.page, pages: meta.pages } } }];
    }],
    ['GET', /^\/projects\/business\/77\/projects$/, (url) => {
      const { items, meta } = page(state.projects, url);
      return [200, { projects: items, meta }];
    }],
    ['GET', /^\/comments\/business\/77\/services$/, (url) => {
      const { items, meta } = page(state.services, url);
      return [200, { services: items, meta }];
    }],
    ['GET', /^\/timetracking\/business\/77\/time_entries$/, (url) => {
      const from = url.searchParams.get('started_from');
      const to = url.searchParams.get('started_to');
      const inRange = state.entries.filter((e) => (!from || e.started_at >= from) && (!to || e.started_at <= to));
      const { items, meta } = page(inRange, url);
      return [200, { time_entries: items, meta: state.omitPages ? { page: meta.page, total: meta.total } : meta }];
    }],
    ['POST', /^\/timetracking\/business\/77\/time_entries$/, (url, body) => {
      const entry = { ...body.time_entry, id: state.nextId++ };
      state.entries.push(entry);
      return [200, { time_entry: entry }];
    }],
    ['PUT', /^\/timetracking\/business\/77\/time_entries\/\d+$/, (url, body) => {
      const entry = state.entries.find((e) => e.id === Number(url.pathname.split('/').at(-1)));
      if (!entry) return [404, { error: 'no entry' }];
      const missing = ['started_at', 'is_logged'].filter((key) => !Object.hasOwn(body?.time_entry ?? {}, key));
      if (missing.length) return [422, { errno: 2001, error: Object.fromEntries(missing.map((key) => [key, 'Field required'])) }];
      Object.assign(entry, body.time_entry);
      return [200, { time_entry: entry }];
    }],
  ];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, 'http://fake');
    const auth = req.headers.authorization ?? null;
    state.log.push({ method: req.method, path: url.pathname, url: req.url, headers: req.headers, body });
    events.push(`http ${req.method} ${url.pathname} ${auth ?? ''}`.trim());
    const failure = state.failures.findIndex((f) => f.method === req.method && url.pathname.endsWith(f.path));
    if (failure !== -1) {
      const [f] = state.failures.splice(failure, 1);
      return send(res, f.status, f.body ?? { error: 'injected' }, f.headers);
    }
    if (url.pathname === '/auth/oauth/token' && req.method === 'POST') return token(body, res);
    if (!auth || !state.access.has(auth.replace(/^Bearer /, ''))) return send(res, 401, { error: 'unauthenticated' });
    const route = routes.find(([method, path]) => method === req.method && path.test(url.pathname));
    if (!route) return send(res, 404, { error: 'no route' });
    const [status, payload] = route[2](url, body);
    return send(res, status, payload);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    posts: () => state.log.filter((r) => r.method === 'POST' && r.path.includes('time_entries')),
    puts: () => state.log.filter((r) => r.method === 'PUT'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
