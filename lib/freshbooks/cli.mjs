import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { REPO, defaultConfigPath, freshbooksSettings, initConfig, loadConfig, normalizeConfig, readRaw, systemTimezone, updateConfig, validateTimezone } from '../config.mjs';
import { planTable } from '../table.mjs';
import { addDays, isDate, localDate, rangeChoices, zonedMidnight } from '../time.mjs';
import { apiBase, createClient, listClients, listProjects, listServices, listTimeEntries } from './api.mjs';
import { CLIENT_SECRET, REFRESH_TOKEN, systemKeychain } from './keychain.mjs';
import { LOOPBACK, login } from './login.mjs';
import { ApprovalError, PushError, buildPlan, isFlatRate, lastBilledDate, push, readLines } from './plan.mjs';

const COMMANDS = ['init', 'configure', 'status', 'store-secret', 'login', 'range', 'choices', 'map', 'unmapped', 'flat-rate', 'plan', 'push'];

const USAGE = `usage: freshbooks/cli.mjs <command> [--config path]
  init                              copy the example config if none exists
  configure [--human-minutes-per-ai-hour n] [--idle-gap-minutes n] [--rounding-step-hours n]
            [--timezone zone|system] [--client-id id] [--redirect-uri url] [--business-id id]
  status
  store-secret                      read the client_secret on stdin
  login [--no-open]
  range
  choices
  map --repo owner/name --client id --project id --service id [--flat-rate-service id]
  unmapped --repo owner/name [--repo ...]
  flat-rate --lines estimate.json [--mark ref ...] [--clear ref ...]
                                    ref: owner/name#number (PR or issue) or owner/name:YYYY-MM-DD (general line)
  plan --lines estimate.json [--format json|table]
  push --lines estimate.json --approve code`;

export class UsageError extends Error {}

const NUMBERS = {
  'human-minutes-per-ai-hour': 'human_minutes_per_ai_hour',
  'idle-gap-minutes': 'idle_gap_minutes',
  'rounding-step-hours': 'rounding_step_hours',
};

const EXAMPLE_CONFIG = fileURLToPath(new URL('../../assets/config.example.json', import.meta.url));
const LAST_BILLED_LOOKBACK_DAYS = 366;

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        repo: { type: 'string', multiple: true },
        client: { type: 'string' },
        project: { type: 'string' },
        service: { type: 'string' },
        'flat-rate-service': { type: 'string' },
        mark: { type: 'string', multiple: true },
        clear: { type: 'string', multiple: true },
        lines: { type: 'string' },
        approve: { type: 'string' },
        format: { type: 'string', default: 'json' },
        'no-open': { type: 'boolean', default: false },
        ...Object.fromEntries([...Object.keys(NUMBERS), 'timezone', 'client-id', 'redirect-uri', 'business-id'].map((flag) => [flag, { type: 'string' }])),
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !COMMANDS.includes(positionals[0])) throw new UsageError(`expected one command: ${COMMANDS.join(', ')}`);
  if (!['json', 'table'].includes(values.format)) throw new UsageError('--format must be json or table');
  if (values.repo && !values.repo.every((r) => REPO.test(r))) throw new UsageError('--repo must look like owner/name');
  return { command: positionals[0], ...values };
}

const id = (value, flag) => {
  if (!/^[1-9]\d{0,15}$/.test(value ?? '')) throw new UsageError(`--${flag} must be a positive integer id`);
  return Number(value);
};

const readEstimate = (path) => {
  if (!path) throw new UsageError('--lines must name the JSON file that bin/estimate.sh printed');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`lines: cannot read JSON from ${path}`);
  }
};

const needBusiness = (settings) => {
  if (!settings.business_id || !settings.account_id) throw new Error('config: no FreshBooks business yet; run bin/login.sh');
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const clientLabel = (c) => c.organization || [c.fname, c.lname].filter(Boolean).join(' ') || `Client ${c.id}`;

async function choices(client, settings) {
  const [clients, projects, services] = await Promise.all([
    listClients(client, settings.account_id),
    listProjects(client, settings.business_id),
    listServices(client, settings.business_id),
  ]);
  return {
    clients: clients.map((c) => ({ id: c.id, label: clientLabel(c), description: c.email || '' })),
    projects: projects.map((p) => ({
      id: p.id,
      label: p.title || `Project ${p.id}`,
      description: p.client_id ? `client ${p.client_id}` : 'no client',
      client_id: p.client_id ?? null,
      service_ids: Array.isArray(p.services) ? p.services.map((s) => s.id) : [],
    })),
    services: services.filter((s) => s.vis_state === undefined || s.vis_state === 0).map((s) => ({ id: s.id, label: s.name || `Service ${s.id}` })),
  };
}

function checkMapping(lists, map) {
  const project = lists.projects.find((p) => p.id === map.project_id);
  if (!lists.clients.some((c) => c.id === map.client_id)) throw new Error(`map: client ${map.client_id} is not an active client of this business`);
  if (!project) throw new Error(`map: project ${map.project_id} is not a project of this business`);
  for (const service of [map.service_id, map.flat_rate_service_id].filter((s) => s !== undefined)) {
    if (!lists.services.some((s) => s.id === service)) throw new Error(`map: service ${service} is not an active service of this business`);
  }
  if (map.flat_rate_service_id === map.service_id) throw new Error('map: the flat-rate service must differ from the hourly service');
  if (project.client_id && project.client_id !== map.client_id) {
    throw new Error(`map: project ${map.project_id} belongs to client ${project.client_id}, not ${map.client_id}`);
  }
}

function changesFrom(options) {
  const top = {};
  for (const [flag, key] of Object.entries(NUMBERS)) {
    if (options[flag] === undefined) continue;
    const value = Number(options[flag]);
    if (!options[flag].trim() || !Number.isFinite(value)) throw new UsageError(`--${flag} must be a number`);
    top[key] = value;
  }
  if (options.timezone !== undefined) top.timezone = options.timezone === 'system' ? null : validateTimezone(options.timezone);
  const fb = {};
  if (options['client-id'] !== undefined) {
    if (!/^\S+$/.test(options['client-id'])) throw new UsageError('--client-id must be one word with no spaces');
    fb.client_id = options['client-id'];
  }
  if (options['business-id'] !== undefined) fb.business_id = id(options['business-id'], 'business-id');
  if (options['redirect-uri'] !== undefined) {
    const host = URL.canParse(options['redirect-uri']) ? new URL(options['redirect-uri']).hostname : null;
    if (!LOOPBACK.has(host)) throw new UsageError('--redirect-uri must be on localhost or 127.0.0.1, because the login listens on this machine');
    fb.redirect_uri = options['redirect-uri'];
  }
  if (!Object.keys(top).length && !Object.keys(fb).length) throw new UsageError('configure needs at least one setting to save');
  return { top, fb };
}

function status(configPath, keychain) {
  const login = { client_secret_saved: keychain.get(CLIENT_SECRET) !== null, logged_in: keychain.get(REFRESH_TOKEN) !== null };
  if (!existsSync(configPath)) return { config_path: configPath, config_exists: false, ...login };
  const raw = readRaw(configPath);
  const config = normalizeConfig(raw);
  const fb = freshbooksSettings(config);
  return {
    config_path: configPath,
    config_exists: true,
    settings: {
      ...Object.fromEntries(['human_minutes_per_ai_hour', 'idle_gap_minutes', 'rounding_step_hours', 'timezone'].map((k) => [k, config[k]])),
      timezone_follows_system: raw.timezone === null || raw.timezone === undefined,
    },
    freshbooks: {
      client_id: fb.client_id,
      redirect_uri: fb.redirect_uri,
      business_id: fb.business_id,
      account_id: fb.account_id,
      mapped_repos: Object.keys(fb.repos).sort(),
    },
    system_timezone: systemTimezone(),
    ...login,
  };
}

const MARK_REF = /^([\w.-]+\/[\w.-]+)(?:#([1-9]\d{0,9})|:(\d{4}-\d{2}-\d{2}))$/;
const MARK_KEYS = { pr: 'flat_rate_prs', issue: 'flat_rate_issues', general: 'flat_rate_days' };

const markRef = (ref) => {
  const m = MARK_REF.exec(ref);
  if (!m || (m[3] && !isDate(m[3]))) {
    throw new UsageError(`--mark and --clear take owner/name#number or owner/name:YYYY-MM-DD, got ${JSON.stringify(ref)}`);
  }
  const repo = m[1].toLowerCase();
  return m[2] ? { repo, value: Number(m[2]), ref: `${repo}#${m[2]}` } : { repo, value: m[3], ref: `${repo}:${m[3]}` };
};

const refOf = (line) => {
  const repo = line.repo.toLowerCase();
  return line.kind === 'general' ? `${repo}:${line.date}` : `${repo}#${line.kind === 'pr' ? line.pr : line.issue}`;
};

function markable(lines, settings) {
  const items = new Map();
  for (const line of lines) {
    const ref = refOf(line);
    const item = items.get(ref) ?? {
      ref,
      kind: line.kind,
      repo: line.repo,
      label: line.kind === 'general' ? `General development on ${line.date}` : line.label,
      flat_rate: isFlatRate(line, settings),
      lines: 0,
      billable_hours: 0,
    };
    item.lines += 1;
    item.billable_hours += line.billable_hours;
    items.set(ref, item);
  }
  return [...items.values()].map((item) => ({
    ...item,
    billable_hours: Math.round(item.billable_hours * 3600) / 3600,
    description: `${item.flat_rate ? 'flat-rate (saved mark)' : 'hourly'}, ${item.lines} line(s), ${item.billable_hours.toFixed(2)} h`,
  }));
}

const savedKeys = (settings, c) => Object.values(MARK_KEYS).filter((key) => (settings[key][c.repo] ?? []).includes(c.value));

function flatRate(options, config, settings, configPath) {
  const lines = readLines(readEstimate(options.lines), config.timezone);
  const mark = (options.mark ?? []).map(markRef);
  const clear = (options.clear ?? []).map(markRef);
  const both = mark.find((m) => clear.some((c) => c.ref === m.ref));
  if (both) throw new UsageError(`${both.ref} is both marked and cleared`);
  const items = new Map(markable(lines, settings).map((item) => [item.ref, item]));
  for (const m of mark) {
    if (!items.has(m.ref)) throw new Error(`flat-rate: ${m.ref} is not a PR, issue or general line in ${options.lines}; nothing was saved`);
  }
  for (const c of clear) {
    if (!savedKeys(settings, c).length) throw new Error(`flat-rate: ${c.ref} has no saved flat-rate mark; nothing was saved`);
  }
  let saved = settings;
  if (mark.length || clear.length) {
    const next = Object.fromEntries(Object.values(MARK_KEYS).map((key) => [key, Object.fromEntries(Object.entries(settings[key]).map(([repo, marks]) => [repo, [...marks]]))]));
    for (const m of mark) {
      const key = MARK_KEYS[items.get(m.ref).kind];
      next[key][m.repo] = [...new Set([...(next[key][m.repo] ?? []), m.value])];
    }
    for (const c of clear) for (const key of savedKeys(settings, c)) next[key][c.repo] = next[key][c.repo].filter((v) => v !== c.value);
    const tidy = (marks) => Object.fromEntries(Object.entries(marks).filter(([, list]) => list.length)
      .map(([repo, list]) => [repo, list.sort((a, b) => (typeof a === 'number' ? a - b : a.localeCompare(b)))]));
    saved = { ...settings, ...Object.fromEntries(Object.entries(next).map(([key, marks]) => [key, tidy(marks)])) };
    updateConfig(configPath, (raw) => {
      raw.freshbooks = { ...raw.freshbooks, ...Object.fromEntries(Object.values(MARK_KEYS).map((key) => [key, saved[key]])) };
    });
  }
  return {
    marked: mark.map((m) => m.ref),
    cleared: clear.map((c) => c.ref),
    items: markable(lines, saved),
  };
}

const readStdin = async (stdin) => {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
};

const openUrl = (url) => spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

export async function run(argv, deps = {}) {
  const options = parse(argv);
  const keychain = deps.keychain ?? systemKeychain();
  const log = deps.log ?? ((text) => process.stderr.write(`${text}\n`));
  const base = deps.base ?? apiBase();

  if (options.command === 'store-secret') {
    const secret = await readStdin(deps.stdin ?? process.stdin);
    if (!secret || /\s/.test(secret)) throw new Error('store-secret: expected one client_secret with no spaces on stdin');
    keychain.set(CLIENT_SECRET, secret);
    return 'client_secret saved to the keychain.\n';
  }

  const configPath = options.config ?? defaultConfigPath();
  if (options.command === 'init') return json({ config_path: configPath, created: initConfig(configPath, EXAMPLE_CONFIG) });
  if (options.command === 'status') return json(status(configPath, keychain));
  if (options.command === 'configure') {
    const { top, fb } = changesFrom(options);
    updateConfig(configPath, (raw) => {
      Object.assign(raw, top);
      if (Object.keys(fb).length) raw.freshbooks = { ...raw.freshbooks, ...fb };
    });
    return json({ saved: { ...top, ...(Object.keys(fb).length ? { freshbooks: fb } : {}) } });
  }

  const config = loadConfig(configPath);
  const settings = freshbooksSettings(config);

  if (options.command === 'unmapped') {
    if (!options.repo) throw new UsageError('unmapped needs at least one --repo');
    const repos = [...new Set(options.repo)];
    return json({
      mapped: repos.filter((r) => settings.repos[r.toLowerCase()]).map((r) => ({ repo: r, ...settings.repos[r.toLowerCase()] })),
      unmapped: repos.filter((r) => !settings.repos[r.toLowerCase()]),
    });
  }

  if (options.command === 'flat-rate') return json(flatRate(options, config, settings, configPath));

  const client = createClient({ settings, keychain, fetch: deps.fetch, base, sleep: deps.sleep });

  if (options.command === 'login') {
    const business = await login({
      settings, keychain, base, log, fetch: deps.fetch,
      open: options['no-open'] ? () => {} : (deps.open ?? openUrl),
    });
    updateConfig(configPath, (raw) => {
      raw.freshbooks = { ...raw.freshbooks, business_id: business.business_id, account_id: business.account_id };
    });
    return json({ logged_in: true, ...business });
  }

  needBusiness(settings);

  if (options.command === 'range') {
    const tz = config.timezone;
    const today = localDate((deps.now ?? Date.now)(), tz);
    const entries = await listTimeEntries(client, settings.business_id,
      new Date(zonedMidnight(addDays(today, -LAST_BILLED_LOOKBACK_DAYS), tz)).toISOString(),
      new Date(zonedMidnight(addDays(today, 1), tz)).toISOString());
    return json(rangeChoices(today, lastBilledDate(entries)));
  }

  if (options.command === 'choices') return json(await choices(client, settings));

  if (options.command === 'map') {
    if (!options.repo || options.repo.length !== 1) throw new UsageError('map needs exactly one --repo');
    const map = { client_id: id(options.client, 'client'), project_id: id(options.project, 'project'), service_id: id(options.service, 'service') };
    if (options['flat-rate-service'] !== undefined) map.flat_rate_service_id = id(options['flat-rate-service'], 'flat-rate-service');
    checkMapping(await choices(client, settings), map);
    const repo = options.repo[0].toLowerCase();
    updateConfig(configPath, (raw) => {
      raw.freshbooks = { ...raw.freshbooks, repos: { ...raw.freshbooks?.repos, [repo]: map } };
    });
    return json({ saved: { repo, ...map } });
  }

  if (options.command === 'push' && !options.approve) {
    throw new UsageError('push needs --approve with the code from the reviewed plan; nothing was created');
  }
  const plan = await buildPlan({ client, settings, estimate: readEstimate(options.lines), timezone: config.timezone });
  if (options.command === 'plan') return options.format === 'table' ? planTable(plan) : json(plan);
  return json(await push({ client, plan, approval: options.approve }));
}

const main = async () => {
  try {
    process.stdout.write(await run(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof PushError) process.stdout.write(json(error.report));
    process.stderr.write(`${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exit(error instanceof UsageError || error instanceof ApprovalError ? 2 : 1);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
