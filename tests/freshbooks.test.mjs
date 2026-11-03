import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { freshbooksSettings, normalizeConfig, updateConfig } from '../lib/config.mjs';
import { apiBase, createClient, pickBusiness } from '../lib/freshbooks/api.mjs';
import { run } from '../lib/freshbooks/cli.mjs';
import { ACCESS_TOKEN, CLIENT_SECRET as SECRET_ACCOUNT, REFRESH_TOKEN, SERVICE, systemKeychain } from '../lib/freshbooks/keychain.mjs';
import { waitForCode } from '../lib/freshbooks/login.mjs';
import { lastBilledDate } from '../lib/freshbooks/plan.mjs';
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
        { id: 501, started_at: '2026-10-14T17:00:00.000Z', note: 'Billed by hand [WBI:Acme/Widgets#12:2026-10-14]' },
        { id: 502, started_at: '2026-10-14T18:00:00.000Z', note: 'Near miss [wbi:acme/widgets#123:2026-10-14]' },
      );
      const lines = [line({ date: '2026-10-14', pr: 12 }), line({ date: '2026-10-14', pr: 1 }), line({ date: '2026-10-14' })];
      const result = await plan(lines);
      assert.deepEqual(result.skip, [{ tag: '[wbi:acme/widgets#12:2026-10-14]', label: 'PR #12: Work', existing_id: 501 }]);
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
      server.state.entries.push({ id: 900, started_at: '2026-10-14T16:00:00.000Z', note: 'x [wbi:acme/widgets:2026-10-14]' });
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
      server.state.entries.push({ id: 900, started_at: '2026-10-14T16:00:00.000Z', note: 'x [wbi:acme/widgets:2026-10-14]' });
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
        assert.deepEqual(error.report.failed, { tag: lines[0].tag, created: 'no', error: error.report.failed.error });
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
      const client = createClient({ settings: { client_id: CLIENT_ID, redirect_uri: 'https://localhost:8080/callback' }, keychain, fetch, base: server.url });
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
      server.state.entries.push({ id: 501, started_at: at('2026-10-16 10:00:00'), note: 'General development [wbi:acme/widgets:2026-10-16]' });
      const table = await cli('plan', '--lines', linesFile(lines), '--format', 'table');
      const widgets = table.indexOf('## acme/widgets');
      const gadgets = table.indexOf('## acme/gadgets');
      assert.ok(widgets !== -1 && gadgets !== -1 && widgets < gadgets, table);
      const widgetRows = table.slice(widgets, gadgets).split('\n').filter((r) => r.startsWith('| 2026'));
      assert.deepEqual(widgetRows.map((r) => r.slice(2, 12)), ['2026-10-12', '2026-10-15']);
      assert.ok(widgetRows.every((r) => r.includes('| session |')));
      assert.match(table.slice(gadgets), /\| 2026-10-13 \| .* \| 0\.25 \| git \(fallback\) \| 6 \| 41 \| 9 \|/);
      assert.match(table.slice(widgets, gadgets), /\| \| \*\*Total\*\* \| 0\.75 \|/);
      assert.match(table, /To create: 3 entries, 1\.00 h\./);
      assert.match(table, /Already in FreshBooks, skipped:\n\n- General development `\[wbi:acme\/widgets:2026-10-16\]` \(entry 501\)/);
      assert.match(table, /Approval code: [0-9a-f]{16}/);
    });
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
        freshbooks: { client_id: CLIENT_ID, redirect_uri: 'https://localhost:8080/callback', business_id: 77, account_id: 'acct9', mapped_repos: ['acme/widgets'] },
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
    assert.equal(settings({}).redirect_uri, 'https://localhost:8080/callback');
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

  it('refuses to listen for a redirect URI that is not on this machine', () => {
    assert.throws(() => waitForCode({ redirectUri: 'https://example.com/callback', state: 's', cert: {}, log: () => {} }), /not localhost or 127\.0\.0\.1/);
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
