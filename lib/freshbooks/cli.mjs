import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { REPO, defaultConfigPath, freshbooksSettings, loadConfig, updateConfig } from '../config.mjs';
import { planTable } from '../table.mjs';
import { apiBase, createClient, listClients, listProjects, listServices } from './api.mjs';
import { CLIENT_SECRET, systemKeychain } from './keychain.mjs';
import { login } from './login.mjs';
import { ApprovalError, PushError, buildPlan, push } from './plan.mjs';

const COMMANDS = ['store-secret', 'login', 'choices', 'map', 'unmapped', 'plan', 'push'];

const USAGE = `usage: freshbooks/cli.mjs <command> [--config path]
  store-secret                      read the client_secret on stdin
  login [--no-open]
  choices
  map --repo owner/name --client id --project id --service id
  unmapped --repo owner/name [--repo ...]
  plan --lines estimate.json [--format json|table]
  push --lines estimate.json --approve code`;

export class UsageError extends Error {}

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
        lines: { type: 'string' },
        approve: { type: 'string' },
        format: { type: 'string', default: 'json' },
        'no-open': { type: 'boolean', default: false },
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
  if (!lists.services.some((s) => s.id === map.service_id)) throw new Error(`map: service ${map.service_id} is not an active service of this business`);
  if (project.client_id && project.client_id !== map.client_id) {
    throw new Error(`map: project ${map.project_id} belongs to client ${project.client_id}, not ${map.client_id}`);
  }
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

  if (options.command === 'choices') return json(await choices(client, settings));

  if (options.command === 'map') {
    if (!options.repo || options.repo.length !== 1) throw new UsageError('map needs exactly one --repo');
    const map = { client_id: id(options.client, 'client'), project_id: id(options.project, 'project'), service_id: id(options.service, 'service') };
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
