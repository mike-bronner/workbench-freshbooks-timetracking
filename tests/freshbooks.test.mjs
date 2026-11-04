import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { freshbooksSettings, normalizeConfig, updateConfig } from '../lib/config.mjs';
import { apiBase, createClient, pickBusiness } from '../lib/freshbooks/api.mjs';
import { run } from '../lib/freshbooks/cli.mjs';
import { ACCESS_TOKEN, CLIENT_SECRET as SECRET_ACCOUNT, REFRESH_TOKEN, SERVICE, systemKeychain } from '../lib/freshbooks/keychain.mjs';
import { selfSignedCert, waitForCode } from '../lib/freshbooks/login.mjs';
import { approvalCode, lastBilledDate, push as pushPlan } from '../lib/freshbooks/plan.mjs';
import { localDate, rangeChoices, zonedMidnight } from '../lib/time.mjs';
import { CLIENT_ID, CLIENT_SECRET, fakeFreshbooks } from './lib/fake-freshbooks.mjs';
import { TZ, at, config, sandbox } from './lib/fixtures.mjs';

const FAKE_SECURITY = fileURLToPath(new URL('./lib/fake-security.mjs', import.meta.url));
const MAPPING = { client_id: 5, project_id: 40, service_id: 9 };

const line = ({ date, pr = null, hours = 0.25, first = `${date} 10:00:00`, repo = 'acme/widgets', label = null }) => ({
  repo,
  date,
  kind: pr ? 'pr' : 'general',
  pr,
  label: label ?? (pr ? `PR #${pr}: Work` : 'General development'),
  billable_hours: hours,
  first_work: at(first),
  tag: pr ? `[wbi:${repo.toLowerCase()}#${pr}:${date}]` : `[wbi:${repo.toLowerCase()}:${date}]`,
});

const estimateOf = (lines, timezone = TZ) => ({ range: { from: '2026-10-01', to: '2026-10-31', timezone }, repos: [{ repo: 'acme/widgets', lines }] });

function memoryKeychain(events, items = {}) {
  return {
    items,
    get: (account) => items[account] ?? null,
    set: (account, value) => {
      events.push(`set ${account}`);
      items[account] = value;
    },
  };
}

describe('freshbooks', () => {
  let box;
  let server;
  let events;
  let keychain;
  let sleeps;
  let configPath;

  beforeEach(async () => {
    box = sandbox();
    events = [];
    sleeps = [];
    server = await fakeFreshbooks({ events });
    const tokens = server.state.seedTokens();
    keychain = memoryKeychain(events, {
      [SECRET_ACCOUNT]: CLIENT_SECRET,
      [REFRESH_TOKEN]: tokens.refresh,
      [ACCESS_TOKEN]: JSON.stringify({ token: tokens.access, expires_at: Date.now() + 3600000 }),
    });
    configPath = join(box.root, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      ...config(),
      freshbooks: { client_id: CLIENT_ID, business_id: 77, account_id: 'acct9', repos: { 'acme/widgets': MAPPING } },
    }));
  });

  afterEach(async () => {
    await server.close();
    box.cleanup();
  });

  const cli = (...args) => run([...args, '--config', configPath], { keychain, base: server.url, sleep: async (ms) => sleeps.push(ms), log: () => {} });
  const linesFile = (lines, timezone) => {
    const path = join(box.root, `lines-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(estimateOf(lines, timezone)));
    return path;
  };
  const plan = async (lines) => JSON.parse(await cli('plan', '--lines', linesFile(lines)));
  const push = async (lines, approve) => JSON.parse(await cli('push', '--lines', linesFile(lines), '--approve', approve));
  const planAndPush = async (lines) => push(lines, (await plan(lines)).approval);
  const tokenCalls = () => server.state.log.filter((r) => r.path === '/auth/oauth/token');

  describe('entries', () => {
    it('builds each entry from its line, with the mapped ids and the tag at the end of the note', async () => {
      const lines = [line({ date: '2026-10-14', pr: 12, hours: 0.75, first: '2026-10-14 23:52:00' }), line({ date: '2026-10-15' })];
      const result = await plan(lines);
      assert.deepEqual(result.create[0].time_entry, {
        is_logged: true,
        duration: 2700,
        started_at: '2026-10-15T06:52:00.000Z',
        note: 'PR #12: Work [wbi:acme/widgets#12:2026-10-14]',
        billable: true,
        ...MAPPING,
      });
      assert.equal(localDate(Date.parse(result.create[0].time_entry.started_at), TZ), '2026-10-14');
      assert.equal(result.create[1].time_entry.duration, 900);
      await push(lines, result.approval);
      assert.deepEqual(server.posts().map((p) => p.body.time_entry), result.create.map((e) => e.time_entry));
    });

    it('refuses a line whose first work is not on its work day', async () => {
      await assert.rejects(plan([line({ date: '2026-10-14', first: '2026-10-15 00:10:00' })]), /not on 2026-10-14 in America\/Phoenix/);
    });

    it('refuses lines estimated in another timezone', async () => {
      await assert.rejects(cli('plan', '--lines', linesFile([line({ date: '2026-10-14' })], 'UTC')), /estimated in UTC.*America\/Phoenix/);
    });

    it('refuses hours that are not whole seconds, and a tag that does not match its line', async () => {
      await assert.rejects(plan([line({ date: '2026-10-14', hours: 0.0001 })]), /not whole seconds/);
      await assert.rejects(plan([{ ...line({ date: '2026-10-14' }), tag: '[wbi:acme/widgets:2026-10-15]' }]), /invalid tag/);
      await assert.rejects(plan([line({ date: '2026-10-14' }), line({ date: '2026-10-14' })]), /appears twice/);
    });

    it('refuses a tag whose repo name only starts with the line repo', async () => {
      await assert.rejects(plan([{ ...line({ date: '2026-10-14' }), tag: '[wbi:acme/widgets-x:2026-10-14]' }]), /invalid tag/);
      await assert.rejects(plan([{ ...line({ date: '2026-10-14', pr: 3 }), tag: '[wbi:acme/widgets.old#3:2026-10-14]' }]), /invalid tag/);
    });

    it('names every repo that has no mapping', async () => {
      await assert.rejects(plan([line({ date: '2026-10-14', repo: 'acme/gadgets' })]), /no FreshBooks mapping for acme\/gadgets/);
    });
  });

  describe('approval', () => {
    const lines = [line({ date: '2026-10-14', pr: 12 }), line({ date: '2026-10-15' })];

    it('makes no POST without an approval code', async () => {
      await assert.rejects(cli('push', '--lines', linesFile(lines)), /needs --approve/);
      assert.equal(server.posts().length, 0);
    });

    it('makes no POST with a wrong code', async () => {
      await assert.rejects(push(lines, 'deadbeefdeadbeef'), /does not match the current plan; nothing was created/);
      assert.equal(server.posts().length, 0);
    });

    it('makes no POST when the line set changed after review', async () => {
      const { approval } = await plan(lines);
      await assert.rejects(push([...lines, line({ date: '2026-10-16' })], approval), /does not match/);
      await assert.rejects(push([lines[0], { ...lines[1], billable_hours: 0.5 }], approval), /does not match/);
      await assert.rejects(push([lines[0]], approval), /does not match/);
      assert.equal(server.posts().length, 0);
    });

    it('creates exactly the reviewed set with the matching code', async () => {
      const report = await planAndPush(lines);
      assert.deepEqual(report.created.map((c) => c.tag), lines.map((l) => l.tag));
      assert.equal(server.posts().length, 2);
    });
  });

  describe('dedup', () => {
    it('skips a line whose tag an existing note carries, ignoring case', async () => {
      server.state.entries.push(
        { id: 501, started_at: '2026-10-14T17:00:00.000Z', note: 'Billed by hand [WBI:Acme/Widgets#12:2026-10-14]', billable: true, service_id: 9, duration: 900 },
        { id: 502, started_at: '2026-10-14T18:00:00.000Z', note: 'Near miss [wbi:acme/widgets#123:2026-10-14]', billable: false, service_id: 11, duration: 900 },
      );
      const lines = [line({ date: '2026-10-14', pr: 12 }), line({ date: '2026-10-14', pr: 1 }), line({ date: '2026-10-14' })];
      const result = await plan(lines);
      assert.deepEqual(result.skip, [{ tag: '[wbi:acme/widgets#12:2026-10-14]', label: 'PR #12: Work', rate: 'hourly', existing_id: 501 }]);
      assert.deepEqual(result.update, []);
      assert.deepEqual(result.create.map((e) => e.tag), [lines[1].tag, lines[2].tag]);
    });

    it('creates no duplicate when a second run overlaps the first', async () => {
      const first = [line({ date: '2026-10-14', pr: 12 }), line({ date: '2026-10-15' })];
      await planAndPush(first);
      const second = [...first, line({ date: '2026-10-16', pr: 12 })];
      const report = await planAndPush(second);
      assert.deepEqual(report.created.map((c) => c.tag), ['[wbi:acme/widgets#12:2026-10-16]']);
      assert.deepEqual(report.skipped.map((s) => s.tag), first.map((l) => l.tag));
      assert.equal(server.posts().length, 3);
      assert.equal(server.state.entries.length, 3);
    });

    it('reads every page of existing entries, with no Content-Type on a GET', async () => {
      for (let i = 0; i < 150; i++) server.state.entries.push({ id: i, started_at: '2026-10-14T15:00:00.000Z', note: `other ${i}` });
      server.state.entries.push({ id: 900, started_at: '2026-10-14T16:00:00.000Z', note: 'x [wbi:acme/widgets:2026-10-14]', billable: true, service_id: 9, duration: 900 });
      const result = await plan([line({ date: '2026-10-14' })]);
      assert.deepEqual(result.skip.map((s) => s.existing_id), [900]);
      const gets = server.state.log.filter((r) => r.method === 'GET');
      assert.deepEqual(gets.map((r) => new URL(r.url, 'http://x').searchParams.get('page')), ['1', '2']);
      assert.equal(new URL(gets[0].url, 'http://x').searchParams.get('per_page'), '100');
      assert.ok(gets.every((r) => r.headers['content-type'] === undefined));
    });

    it('reads until a short page when the response carries no page count', async () => {
      server.state.omitPages = true;
      for (let i = 0; i < 150; i++) server.state.entries.push({ id: i, started_at: '2026-10-14T15:00:00.000Z', note: `other ${i}` });
      server.state.entries.push({ id: 900, started_at: '2026-10-14T16:00:00.000Z', note: 'x [wbi:acme/widgets:2026-10-14]', billable: true, service_id: 9, duration: 900 });
      const result = await plan([line({ date: '2026-10-14' })]);
      assert.deepEqual(result.skip.map((s) => s.existing_id), [900]);
      const pages = server.state.log.filter((r) => r.method === 'GET').map((r) => new URL(r.url, 'http://x').searchParams.get('page'));
      assert.deepEqual(pages, ['1', '2']);
    });

    it('searches a window that covers every line day in the configured zone', async () => {
      await plan([line({ date: '2026-10-14' }), line({ date: '2026-10-20' })]);
      const params = new URL(server.state.log.find((r) => r.method === 'GET').url, 'http://x').searchParams;
      assert.equal(params.get('started_from'), '2026-10-13T07:00:00.000Z');
      assert.equal(params.get('started_to'), '2026-10-22T07:00:00.000Z');
    });
  });

  describe('errors', () => {
    const lines = [line({ date: '2026-10-14', pr: 12 }), line({ date: '2026-10-15' }), line({ date: '2026-10-16' })];

    it('refreshes once on a 401, saves the rotated refresh token first, then retries', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 401 });
      events.length = 0;
      const report = await push(lines, approval);
      assert.equal(report.created.length, 3);
      const fresh = server.state.issued.at(-1);
      assert.equal(keychain.items[REFRESH_TOKEN], fresh.refresh_token);
      const firstUse = events.findIndex((e) => e.endsWith(`Bearer ${fresh.access_token}`));
      assert.ok(events.indexOf('set refresh_token') < events.indexOf('set access_token'));
      assert.ok(events.indexOf('set access_token') < firstUse);
      assert.equal(tokenCalls().length, 1);
    });

    it('stops after one refresh when the 401 persists, and reports what was not created', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 401 }, { method: 'POST', path: 'time_entries', status: 401 });
      await assert.rejects(push(lines, approval), (error) => {
        assert.deepEqual(error.report.failed, { action: 'create', tag: lines[0].tag, created: 'no', error: error.report.failed.error });
        assert.match(error.report.failed.error, /HTTP 401/);
        assert.deepEqual(error.report.not_attempted, [lines[1].tag, lines[2].tag]);
        return true;
      });
      assert.equal(tokenCalls().length, 1);
    });

    it('backs off on a 429, honoring Retry-After', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push(
        { method: 'POST', path: 'time_entries', status: 429, headers: { 'Retry-After': '3' } },
        { method: 'POST', path: 'time_entries', status: 429 },
      );
      const report = await push(lines, approval);
      assert.equal(report.created.length, 3);
      assert.deepEqual(sleeps, [3000, 2000]);
    });

    it('stops on any other error and reports created, failed and not attempted entries', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 200, body: { time_entry: { id: 1, note: lines[0].label + lines[0].tag } } });
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 500, body: { error: 'boom' } });
      await assert.rejects(push(lines, approval), (error) => {
        assert.match(error.message, /stopped at \[wbi:acme\/widgets:2026-10-15\]: .*HTTP 500/);
        assert.deepEqual(error.report.created, [{ tag: lines[0].tag, id: 1 }]);
        assert.equal(error.report.failed.created, 'unknown');
        assert.deepEqual(error.report.not_attempted, [lines[2].tag]);
        return true;
      });
      assert.equal(server.posts().length, 2);
    });

    it('reports a 408 as possibly created, and another 4xx as not created', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 408 });
      await assert.rejects(push(lines, approval), (error) => {
        assert.equal(error.report.failed.created, 'unknown');
        return true;
      });
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 422 });
      await assert.rejects(push(lines, approval), (error) => {
        assert.equal(error.report.failed.created, 'no');
        return true;
      });
    });

    it('stops when FreshBooks drops the tag from a stored note', async () => {
      server.state.mangleNotes = true;
      await assert.rejects(planAndPush(lines), (error) => {
        assert.equal(error.report.failed.created, 'yes');
        assert.match(error.report.failed.error, /without its tag/);
        assert.equal(error.report.not_attempted.length, 2);
        return true;
      });
    });

    it('refreshes an expired access token before the first call', async () => {
      keychain.items[ACCESS_TOKEN] = JSON.stringify({ token: 'stale', expires_at: Date.now() - 1 });
      await plan(lines);
      assert.equal(tokenCalls().length, 1);
      assert.ok(server.state.log.filter((r) => r.method === 'GET').every((r) => r.headers.authorization !== 'Bearer stale'));
    });

    it('reports a failed refresh without echoing any token', async () => {
      keychain.items[ACCESS_TOKEN] = JSON.stringify({ token: 'stale', expires_at: Date.now() - 1 });
      keychain.items[REFRESH_TOKEN] = 'refresh-used-up';
      await assert.rejects(plan(lines), (error) => {
        assert.equal(error.message, 'freshbooks: the token endpoint answered HTTP 400 invalid_grant');
        return true;
      });
    });
  });

  describe('choices and mapping', () => {
    it('lists clients, projects and active services as choices', async () => {
      const choices = JSON.parse(await cli('choices'));
      assert.deepEqual(choices.clients, [{ id: 5, label: 'Acme Corp', description: 'ap@acme.test' }, { id: 6, label: 'Jo Doe', description: '' }]);
      assert.deepEqual(choices.projects[0], { id: 40, label: 'Widgets', description: 'client 5', client_id: 5, service_ids: [9] });
      assert.deepEqual(choices.services, [{ id: 9, label: 'Development' }]);
      const clientsCall = server.state.log.find((r) => r.path.includes('/clients'));
      assert.equal(new URL(clientsCall.url, 'http://x').searchParams.get('search[vis_state]'), '0');
    });

    it('refreshes an expired token once for parallel list calls', async () => {
      keychain.items[ACCESS_TOKEN] = JSON.stringify({ token: 'stale', expires_at: Date.now() - 1 });
      const choices = JSON.parse(await cli('choices'));
      assert.equal(choices.clients.length, 2);
      assert.equal(tokenCalls().length, 1);
      assert.equal(keychain.items[REFRESH_TOKEN], server.state.refresh);
    });

    it('reuses the rotated token when a slow call gets its 401 after the refresh', async () => {
      const fetch = async (url, init) => {
        const res = await globalThis.fetch(url, init);
        if (url.includes('/projects') && res.status === 401) {
          while (!events.includes('set access_token')) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return res;
      };
      server.state.failures.push({ method: 'GET', path: '/clients', status: 401 }, { method: 'GET', path: '/projects', status: 401 });
      const client = createClient({ settings: { client_id: CLIENT_ID, redirect_uri: 'https://localhost:8443' }, keychain, fetch, base: server.url });
      await Promise.all([client.request('GET', '/accounting/account/acct9/users/clients'), client.request('GET', '/projects/business/77/projects')]);
      assert.equal(tokenCalls().length, 1);
    });

    it('refreshes once when parallel list calls all get a 401', async () => {
      for (const path of ['/clients', '/projects', '/services']) server.state.failures.push({ method: 'GET', path, status: 401 });
      const choices = JSON.parse(await cli('choices'));
      assert.equal(choices.services.length, 1);
      assert.equal(tokenCalls().length, 1);
      assert.equal(keychain.items[REFRESH_TOKEN], server.state.refresh);
    });

    it('saves a repo mapping under its lower-case name and keeps the rest of the config', async () => {
      const out = JSON.parse(await cli('map', '--repo', 'Acme/Gadgets', '--client', '6', '--project', '41', '--service', '9'));
      assert.deepEqual(out.saved, { repo: 'acme/gadgets', client_id: 6, project_id: 41, service_id: 9 });
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepEqual(saved.freshbooks.repos, { 'acme/widgets': MAPPING, 'acme/gadgets': { client_id: 6, project_id: 41, service_id: 9 } });
      assert.deepEqual(saved.authors, ['mikebronner']);
    });

    it('refuses an unknown id, a hidden service or a project of another client, and leaves the config alone', async () => {
      const before = readFileSync(configPath, 'utf8');
      const map = (client, project, service) => cli('map', '--repo', 'acme/gadgets', '--client', client, '--project', project, '--service', service);
      await assert.rejects(map('99', '40', '9'), /client 99 is not an active client/);
      await assert.rejects(map('5', '99', '9'), /project 99 is not a project/);
      await assert.rejects(map('5', '40', '10'), /service 10 is not an active service/);
      await assert.rejects(map('6', '40', '9'), /project 40 belongs to client 5, not 6/);
      await assert.rejects(map('0', '40', '9'), /--client must be a positive integer/);
      assert.equal(readFileSync(configPath, 'utf8'), before);
    });

    it('reports which repos in a selection have no mapping', async () => {
      const out = JSON.parse(await cli('unmapped', '--repo', 'Acme/Widgets', '--repo', 'acme/gadgets'));
      assert.deepEqual(out, { mapped: [{ repo: 'Acme/Widgets', ...MAPPING }], unmapped: ['acme/gadgets'] });
    });
  });

  describe('review table', () => {
    it('groups by repo in order of first work, marks git lines, and lists skipped entries', async () => {
      updateConfig(configPath, (raw) => {
        raw.freshbooks.repos['acme/gadgets'] = { client_id: 6, project_id: 41, service_id: 9 };
      });
      const lines = [
        { ...line({ date: '2026-10-13', repo: 'acme/gadgets', first: '2026-10-13 09:00:00' }), source: 'git' },
        { ...line({ date: '2026-10-15', pr: 4, hours: 0.5 }), source: 'session' },
        { ...line({ date: '2026-10-12', first: '2026-10-12 08:00:00' }), source: 'session' },
        { ...line({ date: '2026-10-16' }), source: 'session' },
      ];
      server.state.entries.push({ id: 501, started_at: at('2026-10-16 10:00:00'), note: 'General development [wbi:acme/widgets:2026-10-16]', billable: true, service_id: 9, duration: 900 });
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      const widgets = table.indexOf('## acme/widgets');
      const gadgets = table.indexOf('## acme/gadgets');
      assert.ok(widgets !== -1 && gadgets !== -1 && widgets < gadgets, table);
      const widgetRows = table.slice(widgets, gadgets).split('\n').filter((r) => r.startsWith('| 2026'));
      assert.deepEqual(widgetRows.map((r) => r.slice(2, 12)), ['2026-10-12', '2026-10-15']);
      assert.ok(widgetRows.every((r) => r.includes('| hourly | session |')));
      assert.match(table.slice(gadgets), /\| 2026-10-13 \| .* \| 0\.25 \| hourly \| git \(fallback\) \| 6 \| 41 \| 9 \|/);
      assert.match(table.slice(widgets, gadgets), /\| \| \*\*Total\*\* \| 0\.75 \|/);
      assert.match(table, /To create: 3 entries, 1\.00 h, all billable: 1\.00 h hourly, 0\.00 h flat-rate\./);
      assert.match(table, /Already in FreshBooks and unchanged, skipped: 1 entry\.\n\n- General development `\[wbi:acme\/widgets:2026-10-16\]` \(entry 501, hourly\)/);
      assert.doesNotMatch(table, /To update|Existing entries to update/);
      assert.match(table, /Approval code: [0-9a-f]{16}/);
    });
  });

  describe('flat rate', () => {
    const FLAT = 11;
    const lines = [line({ date: '2026-10-14', pr: 12, hours: 0.75 }), line({ date: '2026-10-15', pr: 12, hours: 0.5 }), line({ date: '2026-10-15', pr: 13, first: '2026-10-15 11:00:00' }), line({ date: '2026-10-16' })];
    const withFlatService = () => updateConfig(configPath, (raw) => {
      raw.freshbooks.repos['acme/widgets'] = { ...MAPPING, flat_rate_service_id: FLAT };
    });
    const flatRate = async (...args) => JSON.parse(await cli('flat-rate', '--lines', linesFile(lines), ...args));
    const savedMarks = () => JSON.parse(readFileSync(configPath, 'utf8')).freshbooks.flat_rate_prs;

    beforeEach(() => {
      server.state.services.push({ id: FLAT, name: 'Milestone', vis_state: 0 });
    });

    it('maps an hourly and a flat-rate service, both checked against FreshBooks', async () => {
      const out = JSON.parse(await cli('map', '--repo', 'acme/gadgets', '--client', '5', '--project', '40', '--service', '9', '--flat-rate-service', String(FLAT)));
      assert.deepEqual(out.saved, { repo: 'acme/gadgets', client_id: 5, project_id: 40, service_id: 9, flat_rate_service_id: FLAT });
      assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).freshbooks.repos['acme/gadgets'], { client_id: 5, project_id: 40, service_id: 9, flat_rate_service_id: FLAT });
      const unmapped = JSON.parse(await cli('unmapped', '--repo', 'acme/gadgets'));
      assert.equal(unmapped.mapped[0].flat_rate_service_id, FLAT);
    });

    it('refuses a hidden, unknown or hourly flat-rate service, and leaves the config alone', async () => {
      const before = readFileSync(configPath, 'utf8');
      const map = (flat) => cli('map', '--repo', 'acme/gadgets', '--client', '5', '--project', '40', '--service', '9', '--flat-rate-service', flat);
      await assert.rejects(map('10'), /service 10 is not an active service/);
      await assert.rejects(map('99'), /service 99 is not an active service/);
      await assert.rejects(map('9'), /flat-rate service must differ from the hourly service/);
      await assert.rejects(map('x'), /--flat-rate-service must be a positive integer/);
      assert.equal(readFileSync(configPath, 'utf8'), before);
    });

    it('lists the PRs, issues and general days of the lines as hourly until one is marked', async () => {
      const out = await flatRate();
      assert.deepEqual(out.items, [
        { ref: 'acme/widgets#12', kind: 'pr', repo: 'acme/widgets', label: 'PR #12: Work', flat_rate: false, lines: 2, billable_hours: 1.25, description: 'hourly, 2 line(s), 1.25 h' },
        { ref: 'acme/widgets#13', kind: 'pr', repo: 'acme/widgets', label: 'PR #13: Work', flat_rate: false, lines: 1, billable_hours: 0.25, description: 'hourly, 1 line(s), 0.25 h' },
        { ref: 'acme/widgets:2026-10-16', kind: 'general', repo: 'acme/widgets', label: 'General development on 2026-10-16', flat_rate: false, lines: 1, billable_hours: 0.25, description: 'hourly, 1 line(s), 0.25 h' },
      ]);
      assert.equal(savedMarks(), undefined);
    });

    it('saves a mark per PR, applies it on a later run, and clears it', async () => {
      withFlatService();
      const marked = await flatRate('--mark', 'Acme/Widgets#13', '--mark', 'acme/widgets#12');
      assert.deepEqual(marked.marked, ['acme/widgets#13', 'acme/widgets#12']);
      assert.deepEqual(savedMarks(), { 'acme/widgets': [12, 13] });
      assert.deepEqual(marked.items.map((p) => [p.ref, p.flat_rate, p.description]), [
        ['acme/widgets#12', true, 'flat-rate (saved mark), 2 line(s), 1.25 h'],
        ['acme/widgets#13', true, 'flat-rate (saved mark), 1 line(s), 0.25 h'],
        ['acme/widgets:2026-10-16', false, 'hourly, 1 line(s), 0.25 h'],
      ]);
      const later = await plan(lines);
      assert.deepEqual(later.create.map((e) => [e.tag, e.rate, e.time_entry.billable, e.time_entry.service_id]), [
        ['[wbi:acme/widgets#12:2026-10-14]', 'flat-rate', true, FLAT],
        ['[wbi:acme/widgets#12:2026-10-15]', 'flat-rate', true, FLAT],
        ['[wbi:acme/widgets#13:2026-10-15]', 'flat-rate', true, FLAT],
        ['[wbi:acme/widgets:2026-10-16]', 'hourly', true, 9],
      ]);
      const cleared = await flatRate('--clear', 'acme/widgets#13');
      assert.deepEqual(cleared.cleared, ['acme/widgets#13']);
      assert.deepEqual(savedMarks(), { 'acme/widgets': [12] });
      assert.deepEqual((await plan(lines)).create.map((e) => e.rate), ['flat-rate', 'flat-rate', 'hourly', 'hourly']);
      await flatRate('--clear', 'acme/widgets#12');
      assert.deepEqual(savedMarks(), {});
      assert.ok((await plan(lines)).create.every((e) => e.rate === 'hourly' && e.time_entry.billable));
    });

    it('refuses a mark for a ref that is not a line, a clear with no saved mark, or a bad ref, and saves nothing', async () => {
      await flatRate('--mark', 'acme/widgets#12');
      const before = readFileSync(configPath, 'utf8');
      await assert.rejects(flatRate('--mark', 'acme/widgets#99'), /acme\/widgets#99 is not a PR, issue or general line in .*; nothing was saved/);
      await assert.rejects(flatRate('--mark', 'acme/widgets#13', '--mark', 'acme/gadgets#13'), /acme\/gadgets#13 is not a PR, issue or general line/);
      await assert.rejects(flatRate('--mark', 'acme/widgets:2026-10-17'), /acme\/widgets:2026-10-17 is not a PR, issue or general line/);
      await assert.rejects(flatRate('--clear', 'acme/widgets#13'), /acme\/widgets#13 has no saved flat-rate mark; nothing was saved/);
      await assert.rejects(flatRate('--clear', 'acme/widgets:2026-10-16'), /acme\/widgets:2026-10-16 has no saved flat-rate mark/);
      await assert.rejects(flatRate('--mark', 'acme/widgets#13', '--clear', 'acme/widgets#13'), /both marked and cleared/);
      for (const ref of ['acme/widgets', 'acme/widgets#0', 'acme/widgets:2026-02-30', 'acme/widgets:20261016', 'acme/widgets#12:2026-10-14']) {
        await assert.rejects(flatRate('--mark', ref), /owner\/name#number or owner\/name:YYYY-MM-DD/);
      }
      assert.equal(readFileSync(configPath, 'utf8'), before);
    });

    it('treats only PR lines as flat-rate, even when another line carries a marked number', async () => {
      withFlatService();
      await flatRate('--mark', 'acme/widgets#12');
      const issue = { ...line({ date: '2026-10-17', pr: 12 }), kind: 'issue', issue: 12, label: 'Issue #12: Work' };
      const result = await plan([lines[0], issue]);
      assert.deepEqual(result.create.map((e) => [e.rate, e.pr]), [['flat-rate', 12], ['hourly', null]]);
    });

    it('posts a flat-rate line as billable under the flat-rate service, and an hourly line as before, with the same tag form', async () => {
      withFlatService();
      await flatRate('--mark', 'acme/widgets#12');
      const reviewed = [lines[0], lines[3]];
      await push(reviewed, (await plan(reviewed)).approval);
      assert.deepEqual(server.posts().map((p) => p.body), [
        { time_entry: { is_logged: true, duration: 2700, started_at: '2026-10-14T17:00:00.000Z', note: 'PR #12: Work [wbi:acme/widgets#12:2026-10-14]', billable: true, client_id: 5, project_id: 40, service_id: FLAT } },
        { time_entry: { is_logged: true, duration: 900, started_at: '2026-10-16T17:00:00.000Z', note: 'General development [wbi:acme/widgets:2026-10-16]', billable: true, client_id: 5, project_id: 40, service_id: 9 } },
      ]);
    });

    it('voids an approval when a line is marked or unmarked after it', async () => {
      withFlatService();
      const hourly = (await plan(lines)).approval;
      await flatRate('--mark', 'acme/widgets#12');
      await assert.rejects(push(lines, hourly), /does not match the current plan; nothing was created/);
      const flat = (await plan(lines)).approval;
      assert.notEqual(flat, hourly);
      await flatRate('--clear', 'acme/widgets#12');
      await assert.rejects(push(lines, flat), /does not match the current plan; nothing was created/);
      assert.equal(server.posts().length, 0);
    });

    it('shows the rate of each line and splits hourly from flat-rate hours in the table', async () => {
      withFlatService();
      await flatRate('--mark', 'acme/widgets#12');
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      const rows = table.split('\n').filter((r) => r.startsWith('| 2026'));
      assert.deepEqual(rows.map((r) => r.split(' | ').slice(3, 4).concat(r.split(' | ').at(-1))), [
        ['flat-rate (saved mark)', '11 |'],
        ['flat-rate (saved mark)', '11 |'],
        ['hourly', '9 |'],
        ['hourly', '9 |'],
      ]);
      assert.match(table, /To create: 4 entries, 1\.75 h, all billable: 0\.50 h hourly, 1\.25 h flat-rate\./);
      assert.match(table, /Approval code: [0-9a-f]{16}/);
    });

    it('blocks a repo with flat-rate lines but no flat-rate service, says why, and creates nothing', async () => {
      const before = (await plan(lines)).approval;
      await flatRate('--mark', 'acme/widgets#13');
      const blocked = await plan(lines);
      assert.equal(blocked.approval, null);
      assert.deepEqual(blocked.blocked.map((b) => b.repo), ['acme/widgets']);
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      assert.match(table, /\| 2026-10-15 \| PR #13: Work .* \| flat-rate \(saved mark\) \| session \| 5 \| 40 \| none \|/);
      assert.match(table, /Cannot create: acme\/widgets has lines marked flat-rate but no flat-rate service mapped\. Map one with map\.sh --flat-rate-service, or clear the marks with flat-rate\.sh\./);
      assert.match(table, /No approval code until every "Cannot" line above is fixed\./);
      assert.doesNotMatch(table, /Approval code:/);
      for (const code of [before, 'null', 'deadbeefdeadbeef']) {
        await assert.rejects(push(lines, code), /no flat-rate service mapped.*; nothing was created or updated/);
      }
      assert.equal(server.posts().length, 0);
    });

    it('blocks a flat-rate line that FreshBooks holds as hourly while its repo has no flat-rate service', async () => {
      await flatRate('--mark', 'acme/widgets#13');
      server.state.entries.push({ id: 502, started_at: at('2026-10-15 11:00:00'), note: 'PR #13: Work [wbi:acme/widgets#13:2026-10-15]', billable: true, service_id: 9, duration: 900 });
      const result = await plan(lines);
      assert.equal(result.approval, null);
      assert.deepEqual(result.blocked.map((b) => [b.action, b.repo]), [['update', 'acme/widgets']]);
      assert.deepEqual([result.update, result.skip], [[], []]);
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      assert.match(table, /Cannot update: acme\/widgets has lines marked flat-rate but no flat-rate service mapped\./);
      assert.doesNotMatch(table, /Approval code:/);
      await assert.rejects(push(lines, 'deadbeefdeadbeef'), /no flat-rate service mapped.*; nothing was created or updated/);
      assert.deepEqual([server.posts().length, server.puts().length], [0, 0]);
    });

    it('refuses a PR line whose pr does not match its tag', async () => {
      await assert.rejects(plan([{ ...line({ date: '2026-10-14', pr: 12 }), pr: 13 }]), /PR line whose pr does not match its tag/);
      await assert.rejects(plan([{ ...line({ date: '2026-10-14', pr: 12 }), pr: '12' }]), /PR line whose pr does not match its tag/);
      await assert.rejects(plan([{ ...line({ date: '2026-10-14', pr: 12 }), pr: 0, tag: '[wbi:acme/widgets#0:2026-10-14]' }]), /PR line whose pr does not match its tag/);
    });

    it('accepts a PR line whose repo is not lower case', async () => {
      const result = await plan([line({ date: '2026-10-14', pr: 12, repo: 'Acme/Widgets' })]);
      assert.deepEqual(result.create.map((e) => [e.tag, e.pr]), [['[wbi:acme/widgets#12:2026-10-14]', 12]]);
    });
  });

  describe('flat-rate marks for issue and general lines', () => {
    const FLAT = 11;
    const issueLine = (date, issue, hours = 0.25) => ({ ...line({ date, hours }), kind: 'issue', issue, label: `Issue #${issue}: LXXVAR`, tag: `[wbi:acme/widgets#${issue}:${date}]` });
    const lines = [line({ date: '2026-10-14', pr: 12 }), issueLine('2026-10-14', 36, 0.5), issueLine('2026-10-15', 36), line({ date: '2026-10-15' }), line({ date: '2026-10-16' })];
    const flatRate = async (...args) => JSON.parse(await cli('flat-rate', '--lines', linesFile(lines), ...args));
    const saved = () => JSON.parse(readFileSync(configPath, 'utf8')).freshbooks;
    const rates = async () => (await plan(lines)).create.map((e) => [e.tag, e.rate, e.time_entry.billable, e.time_entry.service_id]);

    beforeEach(() => {
      server.state.services.push({ id: FLAT, name: 'Milestone', vis_state: 0 });
      updateConfig(configPath, (raw) => {
        raw.freshbooks.repos['acme/widgets'] = { ...MAPPING, flat_rate_service_id: FLAT };
        raw.freshbooks.flat_rate_prs = { 'acme/widgets': [12] };
      });
    });

    it('lists each issue once and each general line by day, beside the PRs', async () => {
      const out = await flatRate();
      assert.deepEqual(out.items.map((i) => [i.ref, i.kind, i.label, i.flat_rate, i.description]), [
        ['acme/widgets#12', 'pr', 'PR #12: Work', true, 'flat-rate (saved mark), 1 line(s), 0.25 h'],
        ['acme/widgets#36', 'issue', 'Issue #36: LXXVAR', false, 'hourly, 2 line(s), 0.75 h'],
        ['acme/widgets:2026-10-15', 'general', 'General development on 2026-10-15', false, 'hourly, 1 line(s), 0.25 h'],
        ['acme/widgets:2026-10-16', 'general', 'General development on 2026-10-16', false, 'hourly, 1 line(s), 0.25 h'],
      ]);
    });

    it('remembers an issue mark by issue, keeps the PR marks, and clears it', async () => {
      const marked = await flatRate('--mark', 'Acme/Widgets#36');
      assert.deepEqual(marked.marked, ['acme/widgets#36']);
      assert.deepEqual(saved().flat_rate_issues, { 'acme/widgets': [36] });
      assert.deepEqual(saved().flat_rate_prs, { 'acme/widgets': [12] });
      assert.deepEqual(saved().flat_rate_days, {});
      assert.deepEqual(await rates(), [
        ['[wbi:acme/widgets#12:2026-10-14]', 'flat-rate', true, FLAT],
        ['[wbi:acme/widgets#36:2026-10-14]', 'flat-rate', true, FLAT],
        ['[wbi:acme/widgets#36:2026-10-15]', 'flat-rate', true, FLAT],
        ['[wbi:acme/widgets:2026-10-15]', 'hourly', true, 9],
        ['[wbi:acme/widgets:2026-10-16]', 'hourly', true, 9],
      ]);
      await flatRate('--clear', 'acme/widgets#36');
      assert.deepEqual(saved().flat_rate_issues, {});
      assert.deepEqual(saved().flat_rate_prs, { 'acme/widgets': [12] });
      assert.deepEqual((await rates()).map((r) => r[1]), ['flat-rate', 'hourly', 'hourly', 'hourly', 'hourly']);
    });

    it('remembers a general mark per repo and day, leaving other days and other lines of that day hourly', async () => {
      await flatRate('--mark', 'acme/widgets:2026-10-15');
      assert.deepEqual(saved().flat_rate_days, { 'acme/widgets': ['2026-10-15'] });
      assert.deepEqual((await rates()).map((r) => r[1]), ['flat-rate', 'hourly', 'hourly', 'flat-rate', 'hourly']);
      const out = await flatRate('--mark', 'acme/widgets:2026-10-16');
      assert.deepEqual(saved().flat_rate_days, { 'acme/widgets': ['2026-10-15', '2026-10-16'] });
      assert.deepEqual(out.items.filter((i) => i.kind === 'general').map((i) => i.flat_rate), [true, true]);
      const cleared = await flatRate('--clear', 'acme/widgets:2026-10-15');
      assert.deepEqual(cleared.cleared, ['acme/widgets:2026-10-15']);
      assert.deepEqual(saved().flat_rate_days, { 'acme/widgets': ['2026-10-16'] });
      assert.deepEqual((await rates()).map((r) => r[1]), ['flat-rate', 'hourly', 'hourly', 'hourly', 'flat-rate']);
    });

    it('does not let a PR mark and an issue mark of the same number cross', async () => {
      await flatRate('--clear', 'acme/widgets#12');
      updateConfig(configPath, (raw) => {
        raw.freshbooks.flat_rate_prs = { 'acme/widgets': [36] };
        raw.freshbooks.flat_rate_issues = { 'acme/widgets': [12] };
      });
      assert.ok((await rates()).every((r) => r[1] === 'hourly'));
      await assert.rejects(flatRate('--clear', 'acme/widgets:2026-10-14'), /has no saved flat-rate mark/);
    });

    it('refuses an issue line whose issue does not match its tag, a general line with a numbered tag, and an unknown kind', async () => {
      await assert.rejects(plan([{ ...issueLine('2026-10-14', 36), issue: 37 }]), /issue line whose issue does not match its tag/);
      await assert.rejects(plan([{ ...issueLine('2026-10-14', 36), issue: null }]), /issue line whose issue does not match its tag/);
      await assert.rejects(plan([{ ...line({ date: '2026-10-14' }), tag: '[wbi:acme/widgets#5:2026-10-14]' }]), /general line whose tag names a PR or issue/);
      await assert.rejects(plan([{ ...line({ date: '2026-10-14' }), kind: 'misc' }]), /unknown kind "misc"/);
    });
  });

  describe('reconcile', () => {
    const FLAT = 11;
    const lines = [line({ date: '2026-10-14', pr: 12, hours: 0.75 }), line({ date: '2026-10-15' }), line({ date: '2026-10-16' }), line({ date: '2026-10-17' })];
    const entry = (id, l, fields) => ({ id, duration: Math.round(l.billable_hours * 3600), started_at: l.first_work, note: `${l.label} ${l.tag}`, client_id: 5, project_id: 40, ...fields });
    const seed = () => {
      server.state.entries.push(
        entry(601, lines[0], { billable: false, service_id: FLAT }),
        entry(602, lines[1], { billable: true, service_id: 9 }),
        entry(603, lines[2], { billable: true, service_id: 9 }),
        { id: 604, duration: 3600, started_at: lines[1].first_work, note: 'Mike by hand on the same day', billable: false, service_id: FLAT, client_id: 5, project_id: 40 },
        { id: 605, duration: 900, started_at: lines[0].first_work, note: 'Near miss [wbi:acme/widgets#123:2026-10-14]', billable: false, service_id: FLAT, client_id: 5, project_id: 40 },
      );
    };
    const snapshot = (id) => structuredClone(server.state.entries.find((e) => e.id === id));

    beforeEach(() => {
      server.state.services.push({ id: FLAT, name: 'Milestone', vis_state: 0 });
      updateConfig(configPath, (raw) => {
        raw.freshbooks.repos['acme/widgets'] = { ...MAPPING, flat_rate_service_id: FLAT };
        raw.freshbooks.flat_rate_prs = { 'acme/widgets': [12] };
        raw.freshbooks.flat_rate_days = { 'acme/widgets': ['2026-10-15'] };
      });
      seed();
    });

    it('lists each tagged entry whose billable flag or service differs as to update, with old and new values', async () => {
      const result = await plan(lines);
      assert.deepEqual(result.create.map((e) => e.tag), [lines[3].tag]);
      assert.deepEqual(result.update.map(({ tag, id, rate, from, to, hours }) => ({ tag, id, rate, from, to, hours })), [
        { tag: lines[0].tag, id: 601, rate: 'flat-rate', from: { billable: false }, to: { billable: true }, hours: 0.75 },
        { tag: lines[1].tag, id: 602, rate: 'flat-rate', from: { service_id: 9 }, to: { service_id: FLAT }, hours: 0.25 },
      ]);
      assert.deepEqual(result.skip, [{ tag: lines[2].tag, label: 'General development', rate: 'hourly', existing_id: 603 }]);
      assert.match(result.approval, /^[0-9a-f]{16}$/);
    });

    it('shows updates apart from new and unchanged entries in the table, and counts them', async () => {
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      const section = table.slice(table.indexOf('## Existing entries to update'), table.indexOf('To create:'));
      assert.match(section, /\| Date \| Note \| Hours \| Rate \| Entry \| Billable \| Service \|/);
      assert.match(section, /\| 2026-10-14 \| PR #12: Work \[wbi:acme\/widgets#12:2026-10-14\] \| 0\.75 \| flat-rate \(saved mark\) \| 601 \| false → true \| unchanged \|/);
      assert.match(section, /\| 2026-10-15 \| General development \[wbi:acme\/widgets:2026-10-15\] \| 0\.25 \| flat-rate \(saved mark\) \| 602 \| unchanged \| 9 → 11 \|/);
      assert.doesNotMatch(section, /604|605|603|2026-10-17/);
      assert.match(table, /## acme\/widgets\n\n.*\n.*\n\| 2026-10-17 \|/);
      assert.match(table, /To create: 1 entry, 0\.25 h, all billable: 0\.25 h hourly, 0\.00 h flat-rate\./);
      assert.match(table, /To update: 2 existing entries, 1 billable change and 1 service change\. Duration, date and note stay as they are\./);
      assert.match(table, /Already in FreshBooks and unchanged, skipped: 1 entry\.\n\n- General development `\[wbi:acme\/widgets:2026-10-16\]` \(entry 603, hourly\)/);
      assert.match(table, /Approval code: [0-9a-f]{16}/);
    });

    it('offers a code for updates alone, and says nothing is left once they are applied', async () => {
      const only = lines.slice(0, 3);
      const table = await cli('plan', '--lines', linesFile(only), '--format', 'table');
      assert.doesNotMatch(table, /To create:/);
      assert.match(table, /Approval code: [0-9a-f]{16}/);
      await push(only, (await plan(only)).approval);
      const after = await cli('plan', '--lines', linesFile(only), '--format', 'table');
      assert.match(after, /Nothing to create or update\./);
      assert.match(after, /skipped: 3 entries\./);
      assert.doesNotMatch(after, /Approval code/);
    });

    it('PUTs only the changed keys of each update under a matching code, after the creates', async () => {
      const result = await plan(lines);
      const report = await push(lines, result.approval);
      assert.deepEqual(server.puts().map((r) => [r.path, r.body]), [
        ['/timetracking/business/77/time_entries/601', { time_entry: { billable: true } }],
        ['/timetracking/business/77/time_entries/602', { time_entry: { service_id: FLAT } }],
      ]);
      const order = server.state.log.filter((r) => r.path.includes('time_entries') && r.method !== 'GET').map((r) => r.method);
      assert.deepEqual(order, ['POST', 'PUT', 'PUT']);
      assert.deepEqual(report.created.map((c) => c.tag), [lines[3].tag]);
      assert.deepEqual(report.updated, [
        { tag: lines[0].tag, id: 601, from: { billable: false }, to: { billable: true } },
        { tag: lines[1].tag, id: 602, from: { service_id: 9 }, to: { service_id: FLAT } },
      ]);
      assert.deepEqual(report.skipped.map((s) => s.existing_id), [603]);
      assert.equal(report.failed, null);
      assert.deepEqual(report.not_attempted, []);
      const again = await plan(lines);
      assert.deepEqual([again.create.length, again.update.length], [0, 0]);
    });

    it('makes no PUT without a code, with a wrong code, or after FreshBooks, a mark or the lines change', async () => {
      const { approval } = await plan(lines);
      await assert.rejects(cli('push', '--lines', linesFile(lines)), /needs --approve/);
      await assert.rejects(push(lines, 'deadbeefdeadbeef'), /does not match the current plan; nothing was created or updated/);
      server.state.entries.find((e) => e.id === 602).service_id = 12;
      await assert.rejects(push(lines, approval), /does not match/);
      server.state.entries.find((e) => e.id === 602).service_id = 9;
      server.state.entries.find((e) => e.id === 601).billable = true;
      await assert.rejects(push(lines, approval), /does not match/);
      server.state.entries.find((e) => e.id === 601).billable = false;
      await cli('flat-rate', '--lines', linesFile(lines), '--clear', 'acme/widgets:2026-10-15');
      await assert.rejects(push(lines, approval), /does not match/);
      assert.equal(server.puts().length, 0);
      assert.equal(server.posts().length, 0);
    });

    it('never updates an entry without a plugin tag, and never changes its duration, date or note', async () => {
      const before = [601, 602, 604, 605].map(snapshot);
      await push(lines, (await plan(lines)).approval);
      assert.deepEqual(server.puts().map((r) => r.path.split('/').at(-1)), ['601', '602']);
      for (const old of before) {
        const now = snapshot(old.id);
        assert.deepEqual([now.duration, now.started_at, now.note], [old.duration, old.started_at, old.note]);
      }
      assert.deepEqual(snapshot(604), before[2]);
      assert.deepEqual(snapshot(605), before[3]);
      assert.ok(server.puts().every((r) => Object.keys(r.body.time_entry).every((k) => ['billable', 'service_id'].includes(k))));
    });

    it('refuses at push an update that targets an untagged entry or changes another field, and changes nothing', async () => {
      const settings = freshbooksSettings(normalizeConfig(JSON.parse(readFileSync(configPath, 'utf8'))));
      const client = createClient({ settings, keychain, base: server.url, sleep: async () => {} });
      const listed = snapshot(601);
      const good = { tag: lines[0].tag, id: 601, repo: 'acme/widgets', note: listed.note, duration: listed.duration, started_at: listed.started_at, from: { billable: false }, to: { billable: true } };
      const attempt = (u) => {
        const crafted = { business_id: 77, blocked: [], create: [], update: [u], skip: [] };
        return pushPlan({ client, plan: { ...crafted, approval: approvalCode(77, [], [u]) }, approval: approvalCode(77, [], [u]) });
      };
      for (const bad of [
        { ...good, id: 604, note: 'Mike by hand on the same day' },
        { ...good, tag: 'mike' },
        { ...good, to: { billable: true, duration: 60 } },
        { ...good, to: { note: 'x' } },
        { ...good, to: {} },
        { ...good, id: '601' },
      ]) {
        await assert.rejects(attempt(bad), /does not target a tagged entry with only billable or service_id; nothing was created or updated/);
      }
      assert.equal(server.puts().length, 0);
      const report = await attempt(good);
      assert.deepEqual(report.updated.map((u) => u.id), [601]);
    });

    it('reports a failed PUT, whether the entry may have changed, and what was not attempted', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'PUT', path: '/601', status: 500 });
      await assert.rejects(push(lines, approval), (error) => {
        assert.match(error.message, /stopped at \[wbi:acme\/widgets#12:2026-10-14\]: .*HTTP 500/);
        assert.deepEqual(error.report.created.map((c) => c.tag), [lines[3].tag]);
        assert.deepEqual(error.report.updated, []);
        assert.deepEqual({ ...error.report.failed, error: null }, { action: 'update', tag: lines[0].tag, id: 601, changed: 'unknown', error: null });
        assert.deepEqual(error.report.not_attempted, [lines[1].tag]);
        assert.deepEqual(error.report.skipped.map((s) => s.existing_id), [603]);
        return true;
      });
      const second = await plan(lines);
      server.state.failures.push({ method: 'PUT', path: '/602', status: 422 });
      await assert.rejects(push(lines, second.approval), (error) => {
        assert.deepEqual(error.report.updated.map((u) => u.id), [601]);
        assert.equal(error.report.failed.changed, 'no');
        assert.deepEqual(error.report.not_attempted, []);
        return true;
      });
    });

    it('reports a PUT whose response does not show the new values as possibly changed', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'PUT', path: '/601', status: 200, body: { time_entry: { id: 601, billable: false } } });
      await assert.rejects(push(lines, approval), (error) => {
        assert.equal(error.report.failed.changed, 'unknown');
        assert.match(error.report.failed.error, /does not show entry 601 with the new values/);
        return true;
      });
      const next = await plan(lines);
      server.state.failures.push({ method: 'PUT', path: '/601', status: 200, body: { time_entry: { id: 999, billable: true } } });
      await assert.rejects(push(lines, next.approval), (error) => error.report.failed.changed === 'unknown');
    });

    it('lists the updates as not attempted when a create fails first', async () => {
      const { approval } = await plan(lines);
      server.state.failures.push({ method: 'POST', path: 'time_entries', status: 422 });
      await assert.rejects(push(lines, approval), (error) => {
        assert.equal(error.report.failed.action, 'create');
        assert.deepEqual(error.report.not_attempted, [lines[0].tag, lines[1].tag]);
        return true;
      });
      assert.equal(server.puts().length, 0);
    });

    it('reads a service id sent as a string as the same service', async () => {
      server.state.entries.find((e) => e.id === 603).service_id = '9';
      const result = await plan(lines);
      assert.deepEqual(result.skip.map((s) => s.existing_id), [603]);
    });

    it('blocks an update whose entry has no valid id, or whose entry carries two tags', async () => {
      server.state.entries.find((e) => e.id === 601).id = null;
      const noId = await plan(lines);
      assert.equal(noId.approval, null);
      assert.match(noId.blocked[0].reason, /carries \[wbi:acme\/widgets#12:2026-10-14\] has no valid id null/);
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      assert.match(table, /Cannot update: an entry that carries .* has no valid id null, so it cannot be updated\./);
      assert.match(table, /No approval code until every "Cannot" line above is fixed\./);
      server.state.entries.find((e) => e.id === null).id = 601;
      server.state.entries.find((e) => e.id === 602).note += ` ${lines[0].tag}`;
      server.state.entries.find((e) => e.id === 601).note = 'moved';
      const twoTags = await plan(lines);
      assert.equal(twoTags.approval, null);
      assert.deepEqual(twoTags.blocked.map((b) => b.reason), [`entry 602 carries the tags of more than one line (${lines[0].tag}, ${lines[1].tag}), so it is ambiguous`]);
      await assert.rejects(push(lines, 'deadbeefdeadbeef'), /ambiguous; nothing was created or updated/);
      assert.equal(server.puts().length, 0);
    });

    it('blocks an entry that carries one tag that matches and one that differs', async () => {
      server.state.entries.find((e) => e.id === 602).note = 'moved';
      server.state.entries.find((e) => e.id === 603).note += ` ${lines[1].tag}`;
      const result = await plan(lines);
      assert.deepEqual(result.update.map((u) => [u.id, u.tag]), [[601, lines[0].tag], [603, lines[1].tag]]);
      assert.deepEqual(result.skip.map((s) => [s.existing_id, s.tag]), [[603, lines[2].tag]]);
      assert.equal(result.approval, null);
      assert.deepEqual(result.blocked.map((b) => b.reason), [`entry 603 carries the tags of more than one line (${lines[1].tag}, ${lines[2].tag}), so it is ambiguous`]);
      await assert.rejects(push(lines, 'deadbeefdeadbeef'), /ambiguous; nothing was created or updated/);
      assert.deepEqual([server.posts().length, server.puts().length], [0, 0]);
    });

    it('blocks existing flat-rate lines, billable or not, when the marked repo has no flat-rate service', async () => {
      updateConfig(configPath, (raw) => {
        raw.freshbooks.repos['acme/widgets'] = MAPPING;
      });
      const result = await plan(lines.slice(0, 3));
      assert.equal(result.approval, null);
      assert.deepEqual(result.blocked.map((b) => [b.action, b.repo]), [['update', 'acme/widgets']]);
      assert.deepEqual(result.update, []);
      assert.deepEqual(result.skip.map((s) => s.existing_id), [603]);
      const table = await cli('plan', '--lines', linesFile(lines.slice(0, 3)), '--format', 'table');
      assert.match(table, /Cannot update: acme\/widgets has lines marked flat-rate but no flat-rate service mapped\./);
      assert.doesNotMatch(table, /601|602/);
      assert.equal(server.puts().length, 0);
    });

    it('blocks instead of guessing when the list leaves out billable or service_id', async () => {
      updateConfig(configPath, (raw) => {
        raw.freshbooks.flat_rate_prs = {};
        raw.freshbooks.flat_rate_days = {};
      });
      for (const e of server.state.entries) {
        delete e.billable;
        delete e.service_id;
      }
      const result = await plan(lines.slice(1, 3));
      assert.deepEqual([result.update, result.skip], [[], []]);
      assert.equal(result.approval, null);
      assert.deepEqual(result.blocked.map((b) => b.reason), ['the FreshBooks list did not return billable, service_id for entry 602, entry 603, so the plan cannot compare them with the lines']);
      const table = await cli('plan', '--lines', linesFile(lines.slice(1, 3)), '--format', 'table');
      assert.doesNotMatch(table, /none →|Existing entries to update/);
      assert.match(table, /Cannot update: the FreshBooks list did not return billable, service_id for entry 602, entry 603/);
      await assert.rejects(push(lines.slice(1, 3), 'deadbeefdeadbeef'), /did not return.*; nothing was created or updated/);
      assert.equal(server.puts().length, 0);
    });

    it('blocks when the list leaves out duration or started_at, which the PUT check needs', async () => {
      delete server.state.entries.find((e) => e.id === 601).duration;
      const result = await plan(lines);
      assert.equal(result.approval, null);
      assert.match(result.blocked[0].reason, /did not return duration for entry 601/);
    });

    for (const [field, mangle] of [
      ['note', (e) => ({ ...e, note: undefined })],
      ['duration', (e) => ({ ...e, duration: 0 })],
      ['started_at', (e) => ({ ...e, started_at: '2026-10-14T00:00:00.000Z' })],
    ]) {
      it(`stops at an update whose PUT response shows a changed ${field}, as possibly changed`, async () => {
        const { approval } = await plan(lines);
        const listed = snapshot(601);
        server.state.failures.push({ method: 'PUT', path: '/601', status: 200, body: { time_entry: mangle({ ...listed, billable: true }) } });
        await assert.rejects(push(lines, approval), (error) => {
          assert.deepEqual({ ...error.report.failed, error: null }, { action: 'update', tag: lines[0].tag, id: 601, changed: 'unknown', error: null });
          assert.match(error.report.failed.error, new RegExp(`shows entry 601 with a changed ${field}; check FreshBooks before a rerun`));
          assert.deepEqual(error.report.updated, []);
          assert.deepEqual(error.report.not_attempted, [lines[1].tag]);
          return true;
        });
        assert.deepEqual(server.puts().map((r) => r.path.split('/').at(-1)), ['601']);
      });
    }
  });

  describe('range', () => {
    const range = async (now) => JSON.parse(await run(['range', '--config', configPath], { keychain, base: server.url, log: () => {}, now: () => Date.parse(now) }));

    it('starts the default range at the latest tagged day in FreshBooks', async () => {
      server.state.entries.push(
        { id: 1, started_at: at('2026-10-20 09:00:00'), note: 'PR #3: Work [wbi:acme/widgets#3:2026-10-20]' },
        { id: 2, started_at: at('2026-10-22 09:00:00'), note: 'General [WBI:Acme/Widgets:2026-10-22]' },
        { id: 3, started_at: at('2026-10-25 09:00:00'), note: 'A meeting I logged by hand' },
      );
      const out = await range('2026-11-03T18:00:00Z');
      assert.deepEqual(out, {
        today: '2026-11-03',
        last_billed: '2026-10-22',
        choices: [
          { label: 'Since last billed', description: '2026-10-22 to 2026-11-03', from: '2026-10-22', to: '2026-11-03' },
          { label: 'This month so far', description: '2026-11-01 to 2026-11-03', from: '2026-11-01', to: '2026-11-03' },
          { label: 'Last month', description: '2026-10-01 to 2026-10-31', from: '2026-10-01', to: '2026-10-31' },
        ],
      });
      const query = new URL(server.state.log.find((r) => r.path.endsWith('/time_entries')).url, 'http://x').searchParams;
      assert.equal(query.get('started_from'), new Date(zonedMidnight('2025-11-02', TZ)).toISOString());
      assert.equal(query.get('started_to'), new Date(zonedMidnight('2026-11-04', TZ)).toISOString());
    });

    it('offers no since-last-billed range when no entry carries a tag, and uses the config timezone for today', async () => {
      server.state.entries.push({ id: 3, started_at: at('2026-10-25 09:00:00'), note: 'A meeting I logged by hand' });
      const out = await range('2026-11-01T05:00:00Z');
      assert.equal(out.today, '2026-10-31');
      assert.equal(out.last_billed, null);
      assert.deepEqual(out.choices.map((c) => c.label), ['This month so far', 'Last month']);
      assert.deepEqual(out.choices[1], { label: 'Last month', description: '2026-09-01 to 2026-09-30', from: '2026-09-01', to: '2026-09-30' });
    });

    it('rolls last month back over a year end and never starts after today', () => {
      assert.deepEqual(rangeChoices('2026-01-05', '2026-02-01').choices.map((c) => [c.from, c.to]), [
        ['2026-01-05', '2026-01-05'], ['2026-01-01', '2026-01-05'], ['2025-12-01', '2025-12-31'],
      ]);
    });

    it('reads the latest tag date across several tags in one note', () => {
      assert.equal(lastBilledDate([{ note: 'x [wbi:a/b:2026-01-02] [wbi:a/b#4:2026-03-01]' }, { note: null }, {}]), '2026-03-01');
      assert.equal(lastBilledDate([{ note: '[wbi:a/b:2026-02-30]' }]), null);
    });
  });

  describe('setup', () => {
    it('copies the example config only when none exists', async () => {
      const fresh = join(box.root, 'nested', 'dir', 'config.json');
      const first = JSON.parse(await run(['init', '--config', fresh], { keychain }));
      assert.deepEqual(first, { config_path: fresh, created: true });
      const example = readFileSync(new URL('../assets/config.example.json', import.meta.url), 'utf8');
      assert.equal(readFileSync(fresh, 'utf8'), example);
      writeFileSync(fresh, '{"edited":true}');
      assert.deepEqual(JSON.parse(await run(['init', '--config', fresh], { keychain })), { config_path: fresh, created: false });
      assert.equal(readFileSync(fresh, 'utf8'), '{"edited":true}');
    });

    it('saves the settings, client id and redirect URI, and keeps the mappings and business', async () => {
      const out = JSON.parse(await cli('configure', '--human-minutes-per-ai-hour', '30', '--idle-gap-minutes', '10',
        '--rounding-step-hours', '0.5', '--timezone', 'Europe/Berlin', '--client-id', 'client-xyz', '--redirect-uri', 'https://127.0.0.1:9443/cb', '--business-id', '78'));
      assert.deepEqual(out.saved, {
        human_minutes_per_ai_hour: 30, idle_gap_minutes: 10, rounding_step_hours: 0.5, timezone: 'Europe/Berlin',
        freshbooks: { client_id: 'client-xyz', redirect_uri: 'https://127.0.0.1:9443/cb', business_id: 78 },
      });
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(saved.idle_gap_minutes, 10);
      assert.deepEqual(saved.freshbooks, { client_id: 'client-xyz', redirect_uri: 'https://127.0.0.1:9443/cb', business_id: 78, account_id: 'acct9', repos: { 'acme/widgets': MAPPING } });
      await cli('configure', '--timezone', 'system');
      assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).timezone, null);
    });

    it('refuses a bad value and leaves the config alone', async () => {
      const before = readFileSync(configPath, 'utf8');
      await assert.rejects(cli('configure'), /at least one setting/);
      await assert.rejects(cli('configure', '--idle-gap-minutes', 'ten'), /--idle-gap-minutes must be a number/);
      await assert.rejects(cli('configure', '--idle-gap-minutes', ' '), /--idle-gap-minutes must be a number/);
      await assert.rejects(cli('configure', '--rounding-step-hours=-1'), /rounding_step_hours must be a positive number/);
      await assert.rejects(cli('configure', '--timezone', 'Mars/Base'), /not a valid IANA zone/);
      await assert.rejects(cli('configure', '--client-id', 'two words'), /--client-id must be one word/);
      await assert.rejects(cli('configure', '--business-id', 'abc'), /--business-id must be a positive integer/);
      await assert.rejects(cli('configure', '--redirect-uri', 'https://example.com/callback'), /must be on localhost or 127\.0\.0\.1/);
      await assert.rejects(cli('configure', '--redirect-uri', 'not a url'), /must be on localhost or 127\.0\.0\.1/);
      await assert.rejects(cli('configure', '--redirect-uri', 'http://localhost:8080/callback'), /must be an https URL/);
      await assert.rejects(cli('configure', '--redirect-uri', 'https://localhost:8080/callback?x=1'), /must be an https URL/);
      assert.equal(readFileSync(configPath, 'utf8'), before);
    });

    it('reports the setup state without a secret or token', async () => {
      const out = await cli('status');
      assert.deepEqual(JSON.parse(out), {
        config_path: configPath,
        config_exists: true,
        settings: { human_minutes_per_ai_hour: 20, idle_gap_minutes: 15, rounding_step_hours: 0.25, timezone: TZ, timezone_follows_system: false },
        freshbooks: { client_id: CLIENT_ID, redirect_uri: 'https://localhost:8443', business_id: 77, account_id: 'acct9', mapped_repos: ['acme/widgets'] },
        system_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        client_secret_saved: true,
        logged_in: true,
      });
      for (const value of Object.values(keychain.items)) assert.ok(!out.includes(value));
    });

    it('tells a pinned timezone from one that follows the machine, even when both name the same zone', async () => {
      const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await cli('configure', '--timezone', system);
      const pinned = JSON.parse(await cli('status')).settings;
      assert.deepEqual([pinned.timezone, pinned.timezone_follows_system], [system, false]);
      await cli('configure', '--timezone', 'system');
      const following = JSON.parse(await cli('status')).settings;
      assert.deepEqual([following.timezone, following.timezone_follows_system], [system, true]);
      updateConfig(configPath, (raw) => {
        delete raw.timezone;
      });
      assert.equal(JSON.parse(await cli('status')).settings.timezone_follows_system, true);
    });

    it('reports a missing config, a missing secret and no login', async () => {
      const empty = memoryKeychain(events);
      const missing = join(box.root, 'none.json');
      assert.deepEqual(JSON.parse(await run(['status', '--config', missing], { keychain: empty })), {
        config_path: missing, config_exists: false, client_secret_saved: false, logged_in: false,
      });
      empty.items[SECRET_ACCOUNT] = 'x';
      const partial = JSON.parse(await run(['status', '--config', configPath], { keychain: empty }));
      assert.deepEqual([partial.client_secret_saved, partial.logged_in], [true, false]);
    });
  });

  it('stores the client_secret read on stdin and never prints it', async () => {
    const out = await run(['store-secret'], { keychain, stdin: Readable.from(['new-secret-77\n']) });
    assert.equal(keychain.items[SECRET_ACCOUNT], 'new-secret-77');
    assert.doesNotMatch(out, /new-secret-77/);
    await assert.rejects(run(['store-secret'], { keychain, stdin: Readable.from(['']) }), /expected one client_secret/);
  });
});

describe('freshbooks keychain', () => {
  const box = sandbox();
  const store = join(box.root, 'keychain.json');
  after(() => box.cleanup());

  it('writes a secret on stdin, reads it back, and never puts it in arguments', () => {
    process.env.WBFT_FAKE_KEYCHAIN = store;
    const keychain = systemKeychain({ bin: FAKE_SECURITY });
    assert.equal(keychain.get(REFRESH_TOKEN), null);
    keychain.set(REFRESH_TOKEN, 'refresh-TOKEN-zz9');
    assert.equal(keychain.get(REFRESH_TOKEN), 'refresh-TOKEN-zz9');
    assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')), { [`${SERVICE}/${REFRESH_TOKEN}`]: 'refresh-TOKEN-zz9' });
    const argv = readFileSync(`${store}.argv`, 'utf8');
    assert.doesNotMatch(argv, /refresh-TOKEN-zz9/);
    assert.doesNotMatch(argv, new RegExp(Buffer.from('refresh-TOKEN-zz9').toString('hex')));
  });

  it('fails when a write does not stick', () => {
    process.env.WBFT_FAKE_KEYCHAIN = store;
    process.env.WBFT_FAKE_KEYCHAIN_DROP_WRITES = '1';
    try {
      assert.throws(() => systemKeychain({ bin: FAKE_SECURITY }).set(ACCESS_TOKEN, 'x'), /saving access_token failed/);
    } finally {
      delete process.env.WBFT_FAKE_KEYCHAIN_DROP_WRITES;
    }
  });
});

describe('freshbooks settings', () => {
  const settings = (freshbooks) => freshbooksSettings(normalizeConfig({ ...config(), freshbooks }));

  it('defaults the redirect URI and lets config override it', () => {
    assert.equal(settings({}).redirect_uri, 'https://localhost:8443');
    assert.equal(settings({ redirect_uri: 'https://localhost:8443' }).redirect_uri, 'https://localhost:8443');
    assert.equal(settings({ redirect_uri: 'https://127.0.0.1:9443/cb' }).redirect_uri, 'https://127.0.0.1:9443/cb');
  });

  it('refuses a redirect URI that is not https or carries a query', () => {
    assert.throws(() => settings({ redirect_uri: 'http://localhost:8080/callback' }), /https URL with no query/);
    assert.throws(() => settings({ redirect_uri: 'https://localhost:8080/callback?x=1' }), /https URL with no query/);
  });

  it('refuses a mapping that is not lower case or lacks an id', () => {
    assert.throws(() => settings({ repos: { 'Acme/Widgets': MAPPING } }), /lower-case owner\/name/);
    assert.throws(() => settings({ repos: { 'acme/widgets': { client_id: 5, project_id: 40 } } }), /needs positive integer/);
  });

  it('loads a mapping with one service, or with a flat-rate service too, and no saved marks', () => {
    assert.deepEqual(settings({ repos: { 'acme/widgets': MAPPING } }).repos, { 'acme/widgets': MAPPING });
    assert.deepEqual(settings({ repos: { 'acme/widgets': { ...MAPPING, flat_rate_service_id: 11 } } }).repos['acme/widgets'].flat_rate_service_id, 11);
    assert.deepEqual(settings({}).flat_rate_prs, {});
  });

  it('refuses a flat-rate service that is not an id or equals the hourly service', () => {
    for (const flat of [0, '11', 9, null]) {
      assert.throws(() => settings({ repos: { 'acme/widgets': { ...MAPPING, flat_rate_service_id: flat } } }), /flat_rate_service_id must be a positive integer other than service_id/);
    }
  });

  it('refuses saved marks that are not distinct PR numbers under a lower-case repo', () => {
    assert.deepEqual(settings({ flat_rate_prs: { 'acme/widgets': [12, 13] } }).flat_rate_prs, { 'acme/widgets': [12, 13] });
    assert.throws(() => settings({ flat_rate_prs: [] }), /flat_rate_prs must be an object/);
    assert.throws(() => settings({ flat_rate_prs: { 'Acme/Widgets': [12] } }), /flat_rate_prs key "Acme\/Widgets" must be a lower-case owner\/name/);
    for (const prs of [[12, 12], [0], ['12'], 12]) {
      assert.throws(() => settings({ flat_rate_prs: { 'acme/widgets': prs } }), /must be a list of distinct PR numbers/);
    }
  });

  it('loads a config that holds only mappings and PR marks, as written by the earlier release', () => {
    const map = { client_id: 1172627, project_id: 12126825, service_id: 24739129, flat_rate_service_id: 26013013 };
    const repos = { 'crossbibleinc/data-importer': map, 'crossbibleinc/bible-models': map, 'crossbibleinc/third': map };
    const prs = { 'crossbibleinc/data-importer': [44, 45], 'crossbibleinc/bible-models': [11] };
    const loaded = settings({ repos, flat_rate_prs: prs });
    assert.deepEqual([loaded.repos, loaded.flat_rate_prs, loaded.flat_rate_issues, loaded.flat_rate_days], [repos, prs, {}, {}]);
  });

  it('loads saved issue and day marks, defaults them to empty, and refuses bad ones', () => {
    assert.deepEqual([settings({}).flat_rate_issues, settings({}).flat_rate_days], [{}, {}]);
    const loaded = settings({ flat_rate_prs: { 'acme/widgets': [45] }, flat_rate_issues: { 'acme/widgets': [36] }, flat_rate_days: { 'acme/widgets': ['2026-10-19'] } });
    assert.deepEqual([loaded.flat_rate_prs, loaded.flat_rate_issues, loaded.flat_rate_days], [{ 'acme/widgets': [45] }, { 'acme/widgets': [36] }, { 'acme/widgets': ['2026-10-19'] }]);
    assert.throws(() => settings({ flat_rate_issues: [] }), /flat_rate_issues must be an object/);
    assert.throws(() => settings({ flat_rate_days: { 'Acme/Widgets': ['2026-10-19'] } }), /flat_rate_days key "Acme\/Widgets" must be a lower-case owner\/name/);
    for (const issues of [[36, 36], [0], ['36']]) {
      assert.throws(() => settings({ flat_rate_issues: { 'acme/widgets': issues } }), /flat_rate_issues\.acme\/widgets must be a list of distinct issue numbers/);
    }
    for (const days of [['2026-10-19', '2026-10-19'], ['2026-02-30'], [20261019], '2026-10-19']) {
      assert.throws(() => settings({ flat_rate_days: { 'acme/widgets': days } }), /flat_rate_days\.acme\/widgets must be a list of distinct YYYY-MM-DD dates/);
    }
  });

  it('refuses to listen for a redirect URI that is not on this machine', async () => {
    await assert.rejects(waitForCode({ redirectUri: 'https://example.com/callback', state: 's', cert: {}, log: () => {} }), /not localhost or 127\.0\.0\.1/);
  });

  const occupy = (address = '127.0.0.1') => new Promise((resolve) => {
    const blocker = createServer((socket) => socket.end());
    blocker.once('error', () => resolve(null));
    blocker.listen(0, address, () => resolve(blocker));
  });

  for (const [host, address] of [['localhost', '127.0.0.1'], ['localhost', '::1'], ['127.0.0.1', '127.0.0.1']]) {
    it(`fails at once, naming the port, when another process holds the ${host} redirect port on ${address}`, async (t) => {
      const blocker = await occupy(address);
      if (!blocker) return t.skip(`this machine cannot listen on ${address}`);
      const { port } = blocker.address();
      const started = Date.now();
      try {
        await assert.rejects(
          waitForCode({ redirectUri: `https://${host}:${port}`, state: 's', cert: selfSignedCert(), timeoutMs: 4000, onListening: () => {}, log: () => {} }),
          (error) => {
            assert.match(error.message, new RegExp(`port ${port} on ${host} is already in use by another process`));
            assert.match(error.message, /\/workbench-freshbooks-timetracking:setup to pick another redirect URI/);
            assert.match(error.message, /set the same URI on the FreshBooks app/);
            return true;
          },
        );
        assert.ok(Date.now() - started < 3000);
      } finally {
        blocker.close();
      }
    });
  }

  it('fails after the probe timeout, naming the port, when the holder of the redirect port never answers', { timeout: 3000 }, async () => {
    const blocker = await occupy();
    const { port } = blocker.address();
    await new Promise((resolve) => blocker.close(resolve));
    const silent = () => Object.assign(new EventEmitter(), {
      setTimeout(ms, onTimeout) {
        this.timer = setTimeout(onTimeout, ms);
      },
      destroy() {
        clearTimeout(this.timer);
      },
    });
    const started = Date.now();
    await assert.rejects(
      waitForCode({ redirectUri: `https://localhost:${port}`, state: 's', cert: selfSignedCert(), timeoutMs: 1500, onListening: () => {}, log: () => {}, probe: { connect: silent, timeoutMs: 200 } }),
      new RegExp(`port ${port} on localhost is already in use by another process`),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 190 && elapsed < 1000, `took ${elapsed} ms`);
  });

  it('catches the code on a redirect URI with no path', async () => {
    const blocker = await occupy();
    const { port } = blocker.address();
    await new Promise((resolve) => blocker.close(resolve));
    const code = await waitForCode({
      redirectUri: `https://localhost:${port}`,
      state: 's',
      cert: selfSignedCert(),
      timeoutMs: 4000,
      log: () => {},
      onListening: () => get(`https://localhost:${port}/?code=c1&state=s`, { rejectUnauthorized: false }, (res) => res.resume()),
    });
    assert.equal(code, 'c1');
  });

  it('refuses an API base that is plain http on a host that is not loopback', () => {
    const saved = process.env.WBFT_FRESHBOOKS_API;
    const baseFor = (value) => {
      process.env.WBFT_FRESHBOOKS_API = value;
      return apiBase();
    };
    try {
      assert.throws(() => baseFor('http://api.freshbooks.com'), /must use https unless its host is loopback/);
      assert.throws(() => baseFor('ftp://127.0.0.1'), /must use https/);
      assert.equal(baseFor('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
      assert.equal(baseFor('http://localhost:9'), 'http://localhost:9');
      assert.equal(baseFor('https://api.example.test'), 'https://api.example.test');
    } finally {
      if (saved === undefined) delete process.env.WBFT_FRESHBOOKS_API;
      else process.env.WBFT_FRESHBOOKS_API = saved;
    }
  });

  it('removes its temp file when saving the config fails', () => {
    const box = sandbox();
    try {
      const path = join(box.root, 'config.json');
      writeFileSync(path, JSON.stringify(config()));
      assert.throws(() => updateConfig(path, () => {
        rmSync(path);
        mkdirSync(join(path, 'blocker'), { recursive: true });
      }));
      assert.deepEqual(readdirSync(box.root), ['config.json']);
    } finally {
      box.cleanup();
    }
  });
});

describe('freshbooks business', () => {
  const me = (...businesses) => ({ response: { business_memberships: businesses.map((business) => ({ business })) } });

  it('picks the only business, or the configured one', () => {
    assert.deepEqual(pickBusiness(me({ id: 1, account_id: 'a1', name: 'One' })), { business_id: 1, account_id: 'a1', name: 'One' });
    assert.equal(pickBusiness(me({ id: 1, account_id: 'a1' }, { id: 2, account_id: 'a2' }), 2).account_id, 'a2');
  });

  it('refuses a login with no account, or several businesses and none chosen', () => {
    assert.throws(() => pickBusiness(me({ id: 1, account_id: null })), /no business with an accounting account/);
    assert.throws(() => pickBusiness({ response: {} }), /no business with an accounting account/);
    assert.throws(() => pickBusiness(me({ id: 1, account_id: 'a1' }, { id: 2, account_id: 'a2' })), /several businesses: 1 \(unnamed\), 2/);
    assert.throws(() => pickBusiness(me({ id: 1, account_id: 'a1' }), 3), /business 3 is not one/);
  });
});
