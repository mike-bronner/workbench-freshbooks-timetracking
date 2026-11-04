import { createHash } from 'node:crypto';

import { REPO } from '../config.mjs';
import { addDays, isDate, localDate, zonedMidnight } from '../time.mjs';
import { createTimeEntry, listTimeEntries, updateTimeEntry } from './api.mjs';
import { KEY, ledgerIds } from './ledger.mjs';

const LEGACY = /\[wbi:([a-z0-9_.-]+\/[a-z0-9_.-]+(?:#\d+)?:\d{4}-\d{2}-\d{2})\]/gi;
const INTERNAL = /\[wbi:/i;

export class ApprovalError extends Error {}

export class PushError extends Error {
  constructor(message, report) {
    super(message);
    this.report = report;
  }
}

const KINDS = ['pr', 'issue', 'general'];
const FORMER = [null, 'primary', 'shared'];
const FIELDS = ['billable', 'service_id', 'note'];
const BODY = ['is_logged', 'started_at', 'duration', 'note', 'client_id', 'project_id', 'service_id', 'billable'];

const bad = (message) => {
  throw new Error(`lines: ${message}`);
};

export const legacyKeys = (note) => [...String(note ?? '').matchAll(LEGACY)].map((m) => m[1].toLowerCase());

const stripLegacy = (note) => String(note ?? '').replace(LEGACY, '').replace(/\s+/g, ' ').trim();

const PICTOGRAPHS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

export const sameNote = (a, b) => [a, b].map((n) => String(n ?? '').replace(PICTOGRAPHS, '').replace(/\s+/g, ' ').trim()).reduce((x, y) => x === y);

const expectedKey = ({ repo, date, kind, pr, issue }) =>
  (kind === 'general' ? `${repo.toLowerCase()}:${date}` : `${repo.toLowerCase()}#${kind === 'pr' ? pr : issue}:${date}`);

const formerKey = (line) => `${line.repo.toLowerCase()}:${line.date}`;

function checkLine(line) {
  if (!line || typeof line !== 'object') bad('every line must be an object');
  const { repo, date, key, label, billable_hours: hours, first_work: firstWork } = line;
  if (typeof repo !== 'string' || !REPO.test(repo)) bad(`a line has an invalid repo ${JSON.stringify(repo)}`);
  if (!isDate(date)) bad(`a line in ${repo} has an invalid date`);
  if (!KINDS.includes(line.kind)) bad(`a line in ${repo} on ${date} has an unknown kind ${JSON.stringify(line.kind)}`);
  if (line.kind === 'pr' && !(Number.isInteger(line.pr) && line.pr > 0)) bad(`a PR line in ${repo} on ${date} has no valid pr`);
  if (line.kind === 'issue' && !(Number.isInteger(line.issue) && line.issue > 0)) bad(`an issue line in ${repo} on ${date} has no valid issue`);
  if (typeof key !== 'string' || !KEY.test(key) || key !== expectedKey(line)) {
    bad(`a line in ${repo} on ${date} has an invalid key ${JSON.stringify(key)}; estimate again`);
  }
  if (typeof label !== 'string' || !label.trim()) bad(`${key} has no label`);
  if (INTERNAL.test(label)) bad(`${key} has a label that holds an internal key`);
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) bad(`${key} has no positive billable_hours`);
  if (typeof firstWork !== 'string' || !Number.isFinite(Date.parse(firstWork))) bad(`${key} has no valid first_work`);
  if (!FORMER.includes(line.former ?? null) || (line.kind === 'general' && line.former)) bad(`${key} has an invalid former ${JSON.stringify(line.former)}`);
  return line;
}

export function readLines(estimate, timezone) {
  if (!estimate || !Array.isArray(estimate.repos)) bad('expected the JSON that bin/estimate.sh prints');
  if (estimate.range?.timezone !== timezone) {
    bad(`they were estimated in ${estimate.range?.timezone ?? 'an unknown zone'}, but the config timezone is ${timezone}; estimate again`);
  }
  const lines = estimate.repos.flatMap((r) => (Array.isArray(r?.lines) ? r.lines : bad('every repo needs a lines list'))).map(checkLine);
  const seen = new Set();
  for (const { key } of lines) {
    if (seen.has(key)) bad(`the key ${key} appears twice`);
    seen.add(key);
  }
  return lines;
}

const startedAt = (line, timezone) => {
  const ms = Math.floor(Date.parse(line.first_work) / 1000) * 1000;
  if (localDate(ms, timezone) !== line.date) bad(`${line.key} starts at ${line.first_work}, which is not on ${line.date} in ${timezone}`);
  return new Date(ms).toISOString();
};

const durationOf = (line) => {
  const seconds = Math.round(line.billable_hours * 3600);
  if (Math.abs(seconds - line.billable_hours * 3600) > 1e-6) bad(`${line.key} has billable hours that are not whole seconds`);
  return seconds;
};

const MARK_OF = {
  pr: (line, settings) => [settings.flat_rate_prs, line.pr],
  issue: (line, settings) => [settings.flat_rate_issues, line.issue],
  general: (line, settings) => [settings.flat_rate_days, line.date],
};

export const isFlatRate = (line, settings) => {
  const [marks, value] = MARK_OF[line.kind]?.(line, settings) ?? [{}, null];
  return (marks?.[line.repo.toLowerCase()] ?? []).includes(value);
};

const isFlatDay = (line, settings) => (settings.flat_rate_days?.[line.repo.toLowerCase()] ?? []).includes(line.date);

const serviceFor = (map, flat) => (flat ? map.flat_rate_service_id ?? null : map.service_id);

export function entriesFor(lines, settings, timezone) {
  const unmapped = [...new Set(lines.filter((l) => !settings.repos[l.repo.toLowerCase()]).map((l) => l.repo))];
  if (unmapped.length) throw new Error(`plan: no FreshBooks mapping for ${unmapped.join(', ')}; save one with bin/map.sh`);
  return lines.map((line) => {
    const map = settings.repos[line.repo.toLowerCase()];
    const flat = isFlatRate(line, settings);
    return {
      key: line.key,
      former: line.former ?? null,
      former_key: line.former ? formerKey(line) : null,
      former_flat: line.former ? isFlatDay(line, settings) : false,
      repo: line.repo,
      date: line.date,
      label: line.label,
      pr: line.kind === 'pr' ? line.pr : null,
      rate: flat ? 'flat-rate' : 'hourly',
      billable_hours: line.billable_hours,
      source: line.source === 'git' ? 'git' : 'session',
      first_work: line.first_work,
      map,
      time_entry: {
        is_logged: true,
        duration: durationOf(line),
        started_at: startedAt(line, timezone),
        note: line.label.trim(),
        billable: true,
        client_id: map.client_id,
        project_id: map.project_id,
        service_id: serviceFor(map, flat),
      },
    };
  });
}

const noFlatService = (entries, action) => [...new Set(entries.map((e) => e.repo))]
  .map((repo) => ({ action, repo, reason: `${repo} has lines marked flat-rate but no flat-rate service mapped. Map one with map.sh --flat-rate-service, or clear the marks with flat-rate.sh` }));

const isEntryId = (id) => Number.isInteger(id) && id > 0;
const SEEN = ['billable', 'service_id', 'duration', 'started_at'];
const unseen = (hit) => SEEN.filter((key) => !Object.hasOwn(hit ?? {}, key));

const USABLE = {
  is_logged: (v) => typeof v === 'boolean',
  started_at: (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
  duration: (v) => Number.isFinite(v),
};
const unusable = (hit) => Object.keys(USABLE).filter((key) => Object.hasOwn(hit, key) && !USABLE[key](hit[key]));

const sameValue = (key, a, b) => {
  if (key === 'started_at') return Date.parse(a) === Date.parse(b);
  if (key.endsWith('_id') && a !== null && a !== undefined && b !== null && b !== undefined) return String(a) === String(b);
  return a === b;
};

const entryName = ({ entry, hit }) => (isEntryId(hit?.id) ? `entry ${hit.id}` : entry.key);

function blockedExisting(matches, incomplete) {
  const blocked = matches.filter((m) => !isEntryId(m.hit?.id))
    .map((m) => ({ action: 'update', repo: m.entry.repo, reason: `an entry matched to ${m.entry.key} has no valid id ${JSON.stringify(m.hit?.id)}, so it cannot be updated` }));
  for (const [list, said] of [[incomplete.filter((m) => m.missing.length), 'did not return'], [incomplete.filter((m) => !m.missing.length), 'returned no valid']]) {
    if (!list.length) continue;
    const keys = [...new Set(list.flatMap((m) => (m.missing.length ? m.missing : m.invalid)))];
    blocked.push({ action: 'update', repo: list[0].entry.repo, reason: `the FreshBooks list ${said} ${keys.join(', ')} for ${list.map(entryName).join(', ')}, so the plan cannot send the full entry that a FreshBooks update requires` });
  }
  const partial = matches.filter(({ hit }) => unseen(hit).length);
  if (partial.length) {
    const keys = [...new Set(partial.flatMap(({ hit }) => unseen(hit)))];
    const which = partial.map(entryName).join(', ');
    blocked.push({ action: 'update', repo: partial[0].entry.repo, reason: `the FreshBooks list did not return ${keys.join(', ')} for ${which}, so the plan cannot compare them with the lines` });
  }
  const claims = new Map();
  for (const { entry, hit } of matches.filter((m) => isEntryId(m.hit?.id))) claims.set(hit.id, new Set([...(claims.get(hit.id) ?? []), entry.key]));
  for (const [id, set] of claims) {
    if (set.size > 1) {
      blocked.push({ action: 'update', repo: matches.find((m) => m.hit?.id === id).entry.repo, reason: `entry ${id} matches more than one line (${[...set].join(', ')}), so it is ambiguous` });
    }
  }
  return blocked;
}

export const approvalCode = (businessId, create, update) => createHash('sha256')
  .update(JSON.stringify({
    business_id: businessId,
    create: create.map((e) => [e.key, e.time_entry]),
    update: update.map((u) => [u.id, u.key, u.from, u.to, u.time_entry]),
  }))
  .digest('hex')
  .slice(0, 16);

const stored = (entry) => ({
  billable: entry?.billable ?? null,
  service_id: entry?.service_id === null || entry?.service_id === undefined ? null : Number(entry.service_id),
  note: entry?.note ?? null,
});

const searchWindow = (dates, timezone) => {
  const sorted = [...dates].sort();
  return [
    new Date(zonedMidnight(addDays(sorted[0], -1), timezone)).toISOString(),
    new Date(zonedMidnight(addDays(sorted.at(-1), 2), timezone)).toISOString(),
  ];
};

function matcher(existing, ledger, timezone) {
  const byId = new Map(existing.filter((e) => isEntryId(e?.id)).map((e) => [e.id, e]));
  const recorded = new Set(Object.values(ledger.entries).flat());
  const tagged = new Map();
  for (const hit of existing) for (const key of legacyKeys(hit?.note)) tagged.set(key, [...(tagged.get(key) ?? []), hit]);
  const missing = [];
  const find = (key) => {
    const hits = [];
    for (const id of ledgerIds(ledger, key)) {
      if (byId.has(id)) hits.push({ hit: byId.get(id), via: 'ledger' });
      else missing.push({ key, id });
    }
    for (const hit of tagged.get(key) ?? []) if (!hits.some((h) => h.hit === hit)) hits.push({ hit, via: 'tag' });
    return hits;
  };
  const unrecorded = (date, projectId, note) => existing
    .filter((hit) => isEntryId(hit?.id) && !recorded.has(hit.id) && !legacyKeys(hit.note).length)
    .filter((hit) => USABLE.started_at(hit.started_at) && localDate(Date.parse(hit.started_at), timezone) === date)
    .filter((hit) => String(hit.project_id) === String(projectId) && sameNote(hit.note, note));
  const fallback = (entry) => (ledgerIds(ledger, entry.key).length ? []
    : unrecorded(entry.date, entry.time_entry.project_id, entry.time_entry.note).map((hit) => ({ hit, via: 'note' })));
  return { find, fallback, unrecorded, missing };
}

function proposal(entry, hit, former) {
  const flat = former ? entry.former_flat : entry.rate === 'flat-rate';
  const target = {
    billable: true,
    service_id: serviceFor(entry.map, flat),
    note: legacyKeys(hit.note).length ? entry.time_entry.note : stored(hit).note,
  };
  return { flat, target };
}

const repoOf = (key) => key.split(/[#:]/)[0];

const cleanNote = (note) => Boolean(note) && !INTERNAL.test(note);

const sameDayLabel = (existing, general, orphan) => existing
  .filter((hit) => isEntryId(hit?.id) && Number.isFinite(hit.duration) && String(hit.project_id) === String(orphan.project_id))
  .filter((hit) => legacyKeys(hit.note).some((k) => k.includes('#') && repoOf(k) === repoOf(general) && k.slice(-10) === general.slice(-10)))
  .map((hit) => ({ id: hit.id, duration: hit.duration, note: stripLegacy(hit.note) }))
  .filter(({ note }) => cleanNote(note))
  .sort((a, b) => b.duration - a.duration || a.id - b.id)[0] ?? null;

function orphanUpdates(existing, claimed, estimate, repos) {
  const from = estimate.range?.from;
  const to = estimate.range?.to;
  const orphans = [];
  const blocked = [];
  for (const hit of existing) {
    const keys = legacyKeys(hit?.note);
    if (!keys.length || claimed.has(hit)) continue;
    const ours = keys.filter((k) => repos.has(k.split(/[#:]/)[0]) && k.slice(-10) >= from && k.slice(-10) <= to);
    if (!ours.length) continue;
    const general = ours.find((k) => !k.includes('#'));
    if (general) {
      const source = sameDayLabel(existing, general, hit);
      if (source) orphans.push({ hit, key: general, note: source.note, sourceId: source.id });
      else blocked.push({ action: 'update', repo: repoOf(general), reason: `entry ${hit.id} still carries the internal key ${general}, but this estimate holds no work in that repo on that day to relabel it with` });
      continue;
    }
    const note = stripLegacy(hit.note);
    if (cleanNote(note)) orphans.push({ hit, key: ours[0], note, sourceId: null });
    else blocked.push({ action: 'update', repo: repoOf(ours[0]), reason: `entry ${hit.id} still carries the internal key ${ours[0]}, but its note without that key is empty or still holds an internal key, so the plan has no label to give it` });
  }
  return { orphans, blocked };
}

export async function buildPlan({ client, settings, estimate, timezone, ledger }) {
  if (!settings.business_id) throw new Error('plan: no business_id in config; run bin/login.sh');
  const entries = entriesFor(readLines(estimate, timezone), settings, timezone);
  const window = entries.length ? searchWindow(entries.map((e) => e.date), timezone) : null;
  const existing = entries.length ? await listTimeEntries(client, settings.business_id, ...window) : [];
  const { find, fallback, unrecorded, missing } = matcher(existing, ledger, timezone);
  const primaryOf = new Map(entries.filter((e) => e.former === 'primary').map((e) => [e.former_key, e]));

  const create = [];
  const matches = [];
  const skip = [];
  const covered = [];
  for (const entry of entries) {
    const own = find(entry.key);
    const found = [
      ...own.map((h) => ({ ...h, key: entry.key, former: false })),
      ...fallback(entry).map((h) => ({ ...h, key: entry.key, former: false })),
      ...(entry.former === 'primary' ? find(entry.former_key).map((h) => ({ ...h, key: entry.former_key, former: true })) : []),
    ];
    if (!found.length && !ledgerIds(ledger, entry.key).length) {
      const billed = entry.former === 'shared' ? find(entry.former_key) : [];
      const primary = primaryOf.get(entry.former_key);
      const maybe = entry.former === 'shared' && primary
        ? unrecorded(primary.date, primary.time_entry.project_id, primary.time_entry.note) : [];
      if (billed.length) covered.push({ key: entry.key, label: entry.label, rate: entry.rate, existing_id: billed[0].hit?.id ?? null, reason: 'former general entry' });
      else if (maybe.length) covered.push({ key: entry.key, label: entry.label, rate: entry.rate, existing_id: maybe[0].id, reason: 'unrecorded entry' });
      else create.push(entry);
    }
    for (const f of found) matches.push({ entry, ...f });
  }

  const update = [];
  const incomplete = [];
  const needsFlat = [];
  for (const m of matches) {
    const { entry, hit } = m;
    if (unseen(hit).length) continue;
    if (m.via === 'note') {
      skip.push({ key: entry.key, label: entry.label, rate: 'as stored', existing_id: hit.id, via: 'note' });
      continue;
    }
    const { flat, target } = proposal(entry, hit, m.former);
    if (target.service_id === null) {
      needsFlat.push(entry);
      continue;
    }
    const keys = FIELDS.filter((k) => stored(hit)[k] !== target[k]);
    const rate = flat ? 'flat-rate' : 'hourly';
    if (!keys.length) {
      skip.push({ key: entry.key, label: entry.label, rate, existing_id: hit?.id ?? null });
      continue;
    }
    const missingBody = BODY.filter((k) => !Object.hasOwn(hit, k));
    const invalid = unusable(hit);
    if (missingBody.length || invalid.length) {
      incomplete.push({ entry, hit, missing: missingBody, invalid });
      continue;
    }
    const to = Object.fromEntries(keys.map((k) => [k, target[k]]));
    update.push({
      key: m.key,
      label: entry.label,
      repo: entry.repo,
      date: entry.date,
      rate,
      id: hit?.id ?? null,
      via: m.via,
      hours: Number.isFinite(hit.duration) ? hit.duration / 3600 : null,
      from: Object.fromEntries(keys.map((k) => [k, stored(hit)[k]])),
      to,
      time_entry: { ...Object.fromEntries(BODY.map((k) => [k, hit[k]])), ...to },
    });
  }

  const claimed = new Set(matches.map((m) => m.hit));
  const repos = new Set(entries.map((e) => e.repo.toLowerCase()));
  const sweep = orphanUpdates(existing, claimed, estimate, repos);
  for (const { hit, key, note, sourceId } of sweep.orphans) {
    const fake = { entry: { key, repo: repoOf(key) }, hit };
    if (!isEntryId(hit.id) || unseen(hit).length || BODY.some((k) => !Object.hasOwn(hit, k)) || unusable(hit).length) {
      incomplete.push({ ...fake, missing: BODY.filter((k) => !Object.hasOwn(hit, k)), invalid: unusable(hit) });
      continue;
    }
    update.push({
      key,
      label: note,
      repo: fake.entry.repo,
      date: key.slice(-10),
      rate: 'as stored',
      id: hit.id,
      via: sourceId === null ? 'tag' : 'same-day',
      ...(sourceId === null ? {} : { relabelled_from: sourceId }),
      hours: Number.isFinite(hit.duration) ? hit.duration / 3600 : null,
      from: { note: hit.note },
      to: { note },
      time_entry: { ...Object.fromEntries(BODY.map((k) => [k, hit[k]])), note },
    });
  }

  const blocked = [
    ...noFlatService(create.filter((e) => e.time_entry.service_id === null), 'create'),
    ...noFlatService(needsFlat, 'update'),
    ...[...new Map(missing.map((m) => [`${m.key}|${m.id}`, m])).values()].map(({ key, id }) => ({ action: 'update', repo: key.split(/[#:]/)[0], reason: `the ledger records entry ${id} for ${key}, but FreshBooks lists no such entry from ${window[0]} to ${window[1]}. If it was deleted or moved, remove it from the ledger` })),
    ...blockedExisting(matches, incomplete),
    ...sweep.blocked,
  ];
  return {
    business_id: settings.business_id,
    timezone,
    approval: blocked.length ? null : approvalCode(settings.business_id, create, update),
    blocked,
    create: create.map(({ map, former, former_key: fk, former_flat: ff, ...rest }) => rest),
    update,
    skip: [...skip, ...covered],
    matched: [
      ...matches.filter((m) => isEntryId(m.hit?.id)).map((m) => ({ key: m.key, id: m.hit.id, via: m.via })),
      ...sweep.orphans.filter((o) => isEntryId(o.hit.id)).map((o) => ({ key: o.key, id: o.hit.id, via: 'tag' })),
    ],
  };
}

export const lastBilledDate = (entries, ledger = { entries: {} }) => {
  const ids = new Set(entries.map((e) => e?.id));
  return [
    ...entries.flatMap((e) => legacyKeys(e?.note)),
    ...Object.entries(ledger.entries).filter(([, list]) => list.some((id) => ids.has(id))).map(([key]) => key),
  ].map((key) => key.slice(-10)).filter(isDate).sort().at(-1) ?? null;
};

const notDoneStatus = (error) => (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408 ? 'no' : 'unknown');

const safeUpdate = (u, ours) => isEntryId(u.id) && ours.has(`${u.key}|${u.id}`)
  && typeof u.key === 'string' && KEY.test(u.key)
  && u.time_entry && Object.keys(u.time_entry).length === BODY.length && BODY.every((k) => Object.hasOwn(u.time_entry, k))
  && typeof u.time_entry.note === 'string' && !INTERNAL.test(u.time_entry.note)
  && u.to && Object.keys(u.to).length > 0 && Object.entries(u.to).every(([k, v]) => FIELDS.includes(k) && u.time_entry[k] === v);

const safeCreate = (e) => typeof e.key === 'string' && KEY.test(e.key)
  && typeof e.time_entry?.note === 'string' && !INTERNAL.test(e.time_entry.note);

async function createOne(client, plan, entry, report, record) {
  let made;
  try {
    made = (await createTimeEntry(client, plan.business_id, entry.time_entry))?.time_entry;
  } catch (error) {
    return { action: 'create', key: entry.key, created: notDoneStatus(error), error: error.message };
  }
  if (!isEntryId(made?.id)) return { action: 'create', key: entry.key, created: 'unknown', error: 'the response carries no time_entry id; check FreshBooks before a rerun' };
  report.created.push({ key: entry.key, id: made.id });
  try {
    record([{ key: entry.key, id: made.id }]);
  } catch (error) {
    return { action: 'create', key: entry.key, created: 'yes', error: `entry ${made.id} exists, but the ledger could not record it: ${error.message}` };
  }
  return null;
}

const shows = (made, u) => made?.id === u.id && Object.entries(u.to).every(([k, v]) => (k === 'note' ? sameNote(made.note, v) : stored(made)[k] === v));

async function updateOne(client, plan, u, report) {
  let made;
  try {
    made = (await updateTimeEntry(client, plan.business_id, u.id, u.time_entry))?.time_entry;
  } catch (error) {
    return { action: 'update', key: u.key, id: u.id, changed: notDoneStatus(error), error: error.message };
  }
  if (!shows(made, u)) return { action: 'update', key: u.key, id: u.id, changed: 'unknown', error: `the response does not show entry ${u.id} with the new values; check FreshBooks before a rerun` };
  const lost = BODY.filter((k) => !Object.hasOwn(u.to, k) && !sameValue(k, made[k], u.time_entry[k]));
  if (lost.length) {
    return { action: 'update', key: u.key, id: u.id, changed: 'unknown', error: `the response shows entry ${u.id} with a changed ${lost.join(', ')}; check FreshBooks before a rerun` };
  }
  report.updated.push({ key: u.key, id: u.id, from: u.from, to: u.to });
  return null;
}

export async function push({ client, plan, approval, record = () => {} }) {
  if (plan.blocked.length) {
    throw new ApprovalError(`push: ${plan.blocked.map((b) => b.reason).join('; ')}; nothing was created or updated`);
  }
  if (typeof approval !== 'string' || approval !== plan.approval) {
    throw new ApprovalError('push: the approval code does not match the current plan; nothing was created or updated. Run bin/plan.sh and review again');
  }
  const ours = new Set((plan.matched ?? []).map((m) => `${m.key}|${m.id}`));
  const unsafe = plan.update.find((u) => !safeUpdate(u, ours));
  if (unsafe) throw new ApprovalError(`push: the update of ${JSON.stringify(unsafe.key)} does not change only the billable flag, service or note of a matched entry, or its note holds an internal key; nothing was created or updated`);
  const unsafeCreate = plan.create.find((e) => !safeCreate(e));
  if (unsafeCreate) throw new ApprovalError(`push: the entry for ${JSON.stringify(unsafeCreate.key)} has a note that holds an internal key; nothing was created or updated`);
  const report = { business_id: plan.business_id, created: [], updated: [], skipped: plan.skip, failed: null, not_attempted: [] };
  const steps = [
    ...plan.create.map((entry) => ({ key: entry.key, run: () => createOne(client, plan, entry, report, record) })),
    ...plan.update.map((u) => ({ key: u.key, run: () => updateOne(client, plan, u, report) })),
  ];
  for (const [i, step] of steps.entries()) {
    report.failed = await step.run();
    if (report.failed) {
      report.not_attempted = steps.slice(i + 1).map((s) => s.key);
      throw new PushError(`push: stopped at ${step.key}: ${report.failed.error}`, report);
    }
  }
  return report;
}
