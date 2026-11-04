import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#\d+)?:\d{4}-\d{2}-\d{2}$/;

const isEntryId = (id) => Number.isInteger(id) && id > 0;

export const ledgerPath = (configPath) => join(dirname(configPath), 'ledger.json');

const empty = (businessId) => ({ business_id: businessId, entries: {} });

export function readLedger(path, businessId) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return empty(businessId);
    throw new Error(`ledger: cannot read ${path}: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`ledger: ${path} is not valid JSON`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
    throw new Error(`ledger: ${path} must hold an object with an entries object`);
  }
  if (raw.business_id !== businessId) {
    throw new Error(`ledger: ${path} belongs to business ${JSON.stringify(raw.business_id)}, not ${businessId}`);
  }
  for (const [key, ids] of Object.entries(raw.entries)) {
    if (!KEY.test(key) || !Array.isArray(ids) || !ids.length || !ids.every(isEntryId)) {
      throw new Error(`ledger: ${path} holds an invalid record for ${JSON.stringify(key)}`);
    }
  }
  return { business_id: businessId, entries: raw.entries };
}

export const ledgerIds = (ledger, key) => ledger.entries[key] ?? [];

export function recordLedger(path, businessId, pairs) {
  const ledger = readLedger(path, businessId);
  let changed = false;
  for (const { key, id } of pairs) {
    if (!KEY.test(key) || !isEntryId(id)) throw new Error(`ledger: refusing to record ${JSON.stringify(key)} as ${JSON.stringify(id)}`);
    const ids = ledger.entries[key] ?? [];
    if (ids.includes(id)) continue;
    ledger.entries[key] = [...ids, id].sort((a, b) => a - b);
    changed = true;
  }
  if (!changed) return false;
  const sorted = { business_id: businessId, entries: Object.fromEntries(Object.entries(ledger.entries).sort(([a], [b]) => a.localeCompare(b))) };
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return true;
}
