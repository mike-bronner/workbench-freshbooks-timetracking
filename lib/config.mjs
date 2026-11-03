import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULTS = Object.freeze({
  human_minutes_per_ai_hour: 20,
  idle_gap_minutes: 15,
  rounding_step_hours: 0.25,
  timezone: null,
});

export const defaultConfigPath = () =>
  process.env.WBFT_CONFIG || join(homedir(), '.config', 'workbench-freshbooks-timetracking', 'config.json');

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

const positive = (config, key) => {
  const value = config[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config: ${key} must be a positive number, got ${JSON.stringify(value)}`);
  }
};

export const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const validateTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`config: timezone ${JSON.stringify(tz)} is not a valid IANA zone`);
  }
  return tz;
};

export function normalizeConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config: the file must hold a JSON object');
  }
  const config = { ...DEFAULTS, ...raw };
  positive(config, 'human_minutes_per_ai_hour');
  positive(config, 'idle_gap_minutes');
  positive(config, 'rounding_step_hours');
  if (config.idle_gap_minutes > 24 * 60) throw new Error('config: idle_gap_minutes must be at most 1440');
  if (!Number.isInteger(config.rounding_step_hours * 3600)) {
    throw new Error('config: rounding_step_hours must be a whole number of seconds');
  }
  const { authors } = config;
  if (!Array.isArray(authors) || authors.length === 0 || !authors.every((a) => typeof a === 'string' && LOGIN.test(a))) {
    throw new Error('config: authors must be a non-empty list of GitHub logins (bots as name[bot])');
  }
  config.timezone = validateTimezone(config.timezone ?? systemTimezone());
  return config;
}

export function readRaw(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`config: cannot read ${path}; run /workbench-freshbooks-timetracking:setup to create it`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`config: ${path} is not valid JSON`);
  }
  return raw;
}

export const loadConfig = (path = defaultConfigPath()) => normalizeConfig(readRaw(path));

export const REPO = /^[\w.-]+\/[\w.-]+$/;
export const DEFAULT_REDIRECT_URI = 'https://localhost:8080/callback';

const isId = (value) => Number.isInteger(value) && value > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const validRedirect = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !value.includes('?') && !value.includes('#');
};

export function freshbooksSettings(config) {
  const raw = config.freshbooks ?? {};
  if (!isObject(raw)) throw new Error('config: freshbooks must be an object');
  const settings = {
    client_id: raw.client_id ?? null,
    redirect_uri: raw.redirect_uri ?? DEFAULT_REDIRECT_URI,
    business_id: raw.business_id ?? null,
    account_id: raw.account_id ?? null,
    repos: raw.repos ?? {},
  };
  if (settings.client_id !== null && (typeof settings.client_id !== 'string' || !settings.client_id.trim())) {
    throw new Error('config: freshbooks.client_id must be a non-empty string');
  }
  if (typeof settings.redirect_uri !== 'string' || !validRedirect(settings.redirect_uri)) {
    throw new Error('config: freshbooks.redirect_uri must be an https URL with no query string');
  }
  if (settings.business_id !== null && !isId(settings.business_id)) throw new Error('config: freshbooks.business_id must be a positive integer');
  if (settings.account_id !== null && (typeof settings.account_id !== 'string' || !settings.account_id)) {
    throw new Error('config: freshbooks.account_id must be a non-empty string');
  }
  if (!isObject(settings.repos)) throw new Error('config: freshbooks.repos must be an object');
  for (const [repo, map] of Object.entries(settings.repos)) {
    if (!REPO.test(repo) || repo !== repo.toLowerCase()) throw new Error(`config: freshbooks.repos key ${JSON.stringify(repo)} must be a lower-case owner/name`);
    if (!isObject(map) || !['client_id', 'project_id', 'service_id'].every((k) => isId(map[k]))) {
      throw new Error(`config: freshbooks.repos.${repo} needs positive integer client_id, project_id and service_id`);
    }
  }
  return settings;
}

export function updateConfig(path, mutate) {
  const raw = readRaw(path);
  mutate(raw);
  normalizeConfig(raw);
  freshbooksSettings(raw);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function initConfig(path, example) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    copyFileSync(example, path, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}
