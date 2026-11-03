import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function loadConfig(path = defaultConfigPath()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`config: cannot read ${path}; copy assets/config.example.json there and edit it`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`config: ${path} is not valid JSON`);
  }
  return normalizeConfig(raw);
}
