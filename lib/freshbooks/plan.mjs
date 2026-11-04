import { createHash } from 'node:crypto';

import { REPO } from '../config.mjs';
import { addDays, isDate, localDate, zonedMidnight } from '../time.mjs';
import { createTimeEntry, listTimeEntries, updateTimeEntry } from './api.mjs';

const TAG = /^\[wbi:[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#\d+)?:\d{4}-\d{2}-\d{2}\]$/;

export class ApprovalError extends Error {}

export class PushError extends Error {
  constructor(message, report) {
    super(message);
    this.report = report;
  }
}

const KINDS = ['pr', 'issue', 'general'];
const FIELDS = ['billable', 'service_id'];

const bad = (message) => {
  throw new Error(`lines: ${message}`);
};

function checkLine(line) {
  if (!line || typeof line !== 'object') bad('every line must be an object');
  const { repo, date, tag, label, billable_hours: hours, first_work: firstWork } = line;
  if (typeof repo !== 'string' || !REPO.test(repo)) bad(`a line has an invalid repo ${JSON.stringify(repo)}`);
  if (!isDate(date)) bad(`a line in ${repo} has an invalid date`);
  if (typeof tag !== 'string' || !TAG.test(tag) || ![':', '#'].some((end) => tag.startsWith(`[wbi:${repo.toLowerCase()}${end}`)) || !tag.endsWith(`:${date}]`)) {
    bad(`a line in ${repo} on ${date} has an invalid tag ${JSON.stringify(tag)}`);
  }
  if (typeof label !== 'string' || !label.trim()) bad(`${tag} has no label`);
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) bad(`${tag} has no positive billable_hours`);
  if (typeof firstWork !== 'string' || !Number.isFinite(Date.parse(firstWork))) bad(`${tag} has no valid first_work`);
  if (!KINDS.includes(line.kind)) bad(`${tag} has an unknown kind ${JSON.stringify(line.kind)}`);
  if (line.kind === 'pr' && !(Number.isInteger(line.pr) && line.pr > 0 && tag.startsWith(`[wbi:${repo.toLowerCase()}#${line.pr}:`))) {
    bad(`${tag} is a PR line whose pr does not match its tag`);
  }
  if (line.kind === 'issue' && !(Number.isInteger(line.issue) && line.issue > 0 && tag.startsWith(`[wbi:${repo.toLowerCase()}#${line.issue}:`))) {
    bad(`${tag} is an issue line whose issue does not match its tag`);
  }
  if (line.kind === 'general' && tag !== `[wbi:${repo.toLowerCase()}:${date}]`) bad(`${tag} is a general line whose tag names a PR or issue`);
  return line;
}

export function readLines(estimate, timezone) {
  if (!estimate || !Array.isArray(estimate.repos)) bad('expected the JSON that bin/estimate.sh prints');
  if (estimate.range?.timezone !== timezone) {
    bad(`they were estimated in ${estimate.range?.timezone ?? 'an unknown zone'}, but the config timezone is ${timezone}; estimate again`);
  }
  const lines = estimate.repos.flatMap((r) => (Array.isArray(r?.lines) ? r.lines : bad('every repo needs a lines list'))).map(checkLine);
  const seen = new Set();
  for (const { tag } of lines) {
    if (seen.has(tag)) bad(`the tag ${tag} appears twice`);
    seen.add(tag);
  }
  return lines;
}

const startedAt = (line, timezone) => {
  const ms = Math.floor(Date.parse(line.first_work) / 1000) * 1000;
  if (localDate(ms, timezone) !== line.date) bad(`${line.tag} starts at ${line.first_work}, which is not on ${line.date} in ${timezone}`);
  return new Date(ms).toISOString();
};

const durationOf = (line) => {
  const seconds = Math.round(line.billable_hours * 3600);
  if (Math.abs(seconds - line.billable_hours * 3600) > 1e-6) bad(`${line.tag} has billable hours that are not whole seconds`);
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

export function entriesFor(lines, settings, timezone) {
  const unmapped = [...new Set(lines.filter((l) => !settings.repos[l.repo.toLowerCase()]).map((l) => l.repo))];
  if (unmapped.length) throw new Error(`plan: no FreshBooks mapping for ${unmapped.join(', ')}; save one with bin/map.sh`);
  return lines.map((line) => {
    const map = settings.repos[line.repo.toLowerCase()];
    const flat = isFlatRate(line, settings);
    return {
      tag: line.tag,
      repo: line.repo,
      date: line.date,
      label: line.label,
      pr: line.kind === 'pr' ? line.pr : null,
      rate: flat ? 'flat-rate' : 'hourly',
      billable_hours: line.billable_hours,
      source: line.source === 'git' ? 'git' : 'session',
      first_work: line.first_work,
      time_entry: {
        is_logged: true,
        duration: durationOf(line),
        started_at: startedAt(line, timezone),
        note: `${line.label} ${line.tag}`,
        billable: true,
        client_id: map.client_id,
        project_id: map.project_id,
        service_id: flat ? map.flat_rate_service_id ?? null : map.service_id,
      },
    };
  });
}

const noFlatService = (entries, action) => [...new Set(entries.filter((e) => e.time_entry.service_id === null).map((e) => e.repo))]
  .map((repo) => ({ action, repo, reason: `${repo} has lines marked flat-rate but no flat-rate service mapped. Map one with map.sh --flat-rate-service, or clear the marks with flat-rate.sh` }));

const isEntryId = (id) => Number.isInteger(id) && id > 0;
const SEEN = ['billable', 'service_id', 'duration', 'started_at'];
const unseen = (hit) => SEEN.filter((key) => !Object.hasOwn(hit ?? {}, key));

function blockedExisting(matches, update) {
  const blocked = update.filter((u) => !isEntryId(u.id))
    .map((u) => ({ action: 'update', repo: u.repo, reason: `an entry that carries ${u.tag} has no valid id ${JSON.stringify(u.id)}, so it cannot be updated` }));
  const partial = matches.filter(({ hit }) => unseen(hit).length);
  if (partial.length) {
    const keys = [...new Set(partial.flatMap(({ hit }) => unseen(hit)))];
    const which = partial.map(({ entry, hit }) => (isEntryId(hit?.id) ? `entry ${hit.id}` : entry.tag)).join(', ');
    blocked.push({ action: 'update', repo: partial[0].entry.repo, reason: `the FreshBooks list did not return ${keys.join(', ')} for ${which}, so the plan cannot compare them with the lines` });
  }
  const tags = new Map();
  for (const { entry, hit } of matches.filter((m) => isEntryId(m.hit?.id))) tags.set(hit.id, new Set([...(tags.get(hit.id) ?? []), entry.tag]));
  for (const [id, set] of tags) {
    if (set.size > 1) {
      blocked.push({ action: 'update', repo: matches.find((m) => m.hit?.id === id).entry.repo, reason: `entry ${id} carries the tags of more than one line (${[...set].join(', ')}), so it is ambiguous` });
    }
  }
  return blocked;
}

export const approvalCode = (businessId, create, update) => createHash('sha256')
  .update(JSON.stringify({
    business_id: businessId,
    create: create.map((e) => [e.tag, e.time_entry]),
    update: update.map((u) => [u.id, u.tag, u.from, u.to]),
  }))
  .digest('hex')
  .slice(0, 16);

const stored = (entry) => ({
  billable: entry?.billable ?? null,
  service_id: entry?.service_id === null || entry?.service_id === undefined ? null : Number(entry.service_id),
});

const changedFields = (found, entry) => FIELDS.filter((key) => stored(found)[key] !== entry.time_entry[key]);

const searchWindow = (dates, timezone) => {
  const sorted = [...dates].sort();
  return [
    new Date(zonedMidnight(addDays(sorted[0], -1), timezone)).toISOString(),
    new Date(zonedMidnight(addDays(sorted.at(-1), 2), timezone)).toISOString(),
  ];
};

export async function buildPlan({ client, settings, estimate, timezone }) {
  if (!settings.business_id) throw new Error('plan: no business_id in config; run bin/login.sh');
  const entries = entriesFor(readLines(estimate, timezone), settings, timezone);
  const existing = entries.length
    ? await listTimeEntries(client, settings.business_id, ...searchWindow(entries.map((e) => e.date), timezone))
    : [];
  const create = [];
  const matches = [];
  const update = [];
  const skip = [];
  for (const entry of entries) {
    const hits = existing.filter((e) => String(e?.note ?? '').toLowerCase().includes(entry.tag));
    if (!hits.length) create.push(entry);
    for (const hit of hits) {
      matches.push({ entry, hit });
      if (unseen(hit).length || entry.time_entry.service_id === null) continue;
      const keys = changedFields(hit, entry);
      if (!keys.length) {
        skip.push({ tag: entry.tag, label: entry.label, rate: entry.rate, existing_id: hit?.id ?? null });
        continue;
      }
      update.push({
        tag: entry.tag,
        label: entry.label,
        repo: entry.repo,
        date: entry.date,
        rate: entry.rate,
        id: hit?.id ?? null,
        note: String(hit.note),
        duration: hit.duration,
        started_at: hit.started_at,
        hours: Number.isFinite(hit.duration) ? hit.duration / 3600 : null,
        from: Object.fromEntries(keys.map((k) => [k, stored(hit)[k]])),
        to: Object.fromEntries(keys.map((k) => [k, entry.time_entry[k]])),
      });
    }
  }
  const blocked = [
    ...noFlatService(create, 'create'),
    ...noFlatService(matches.map((m) => m.entry), 'update'),
    ...blockedExisting(matches, update),
  ];
  return {
    business_id: settings.business_id,
    timezone,
    approval: blocked.length ? null : approvalCode(settings.business_id, create, update),
    blocked,
    create,
    update,
    skip,
  };
}

const TAG_DATE = /\[wbi:[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#\d+)?:(\d{4}-\d{2}-\d{2})\]/gi;

export const lastBilledDate = (entries) => entries
  .flatMap((e) => [...String(e?.note ?? '').matchAll(TAG_DATE)].map((m) => m[1]))
  .filter(isDate)
  .sort()
  .at(-1) ?? null;

const notDoneStatus = (error) => (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408 ? 'no' : 'unknown');

const safeUpdate = (u) => isEntryId(u.id)
  && typeof u.tag === 'string' && TAG.test(u.tag)
  && typeof u.note === 'string' && u.note.toLowerCase().includes(u.tag)
  && u.to && Object.keys(u.to).length > 0 && Object.keys(u.to).every((k) => FIELDS.includes(k));

async function createOne(client, plan, entry, report) {
  let made;
  try {
    made = (await createTimeEntry(client, plan.business_id, entry.time_entry))?.time_entry;
  } catch (error) {
    return { action: 'create', tag: entry.tag, created: notDoneStatus(error), error: error.message };
  }
  if (!made?.id) return { action: 'create', tag: entry.tag, created: 'unknown', error: 'the response carries no time_entry id; check FreshBooks before a rerun' };
  report.created.push({ tag: entry.tag, id: made.id });
  if (!String(made.note ?? '').toLowerCase().includes(entry.tag)) {
    return { action: 'create', tag: entry.tag, created: 'yes', error: `FreshBooks stored entry ${made.id} without its tag in the note, so a rerun cannot detect it` };
  }
  return null;
}

async function updateOne(client, plan, u, report) {
  let made;
  try {
    made = (await updateTimeEntry(client, plan.business_id, u.id, u.to))?.time_entry;
  } catch (error) {
    return { action: 'update', tag: u.tag, id: u.id, changed: notDoneStatus(error), error: error.message };
  }
  const shows = made?.id === u.id && Object.entries(u.to).every(([k, v]) => stored(made)[k] === v);
  if (!shows) return { action: 'update', tag: u.tag, id: u.id, changed: 'unknown', error: `the response does not show entry ${u.id} with the new values; check FreshBooks before a rerun` };
  const kept = { duration: made.duration === u.duration, started_at: Date.parse(made.started_at) === Date.parse(u.started_at), note: made.note === u.note };
  const lost = Object.keys(kept).filter((k) => !kept[k]);
  if (lost.length) {
    return { action: 'update', tag: u.tag, id: u.id, changed: 'unknown', error: `the response shows entry ${u.id} with a changed ${lost.join(', ')}; check FreshBooks before a rerun` };
  }
  report.updated.push({ tag: u.tag, id: u.id, from: u.from, to: u.to });
  return null;
}

export async function push({ client, plan, approval }) {
  if (plan.blocked.length) {
    throw new ApprovalError(`push: ${plan.blocked.map((b) => b.reason).join('; ')}; nothing was created or updated`);
  }
  if (typeof approval !== 'string' || approval !== plan.approval) {
    throw new ApprovalError('push: the approval code does not match the current plan; nothing was created or updated. Run bin/plan.sh and review again');
  }
  const unsafe = plan.update.find((u) => !safeUpdate(u));
  if (unsafe) throw new ApprovalError(`push: the update of ${JSON.stringify(unsafe.tag)} does not target a tagged entry with only billable or service_id; nothing was created or updated`);
  const report = { business_id: plan.business_id, created: [], updated: [], skipped: plan.skip, failed: null, not_attempted: [] };
  const steps = [
    ...plan.create.map((entry) => ({ tag: entry.tag, run: () => createOne(client, plan, entry, report) })),
    ...plan.update.map((u) => ({ tag: u.tag, run: () => updateOne(client, plan, u, report) })),
  ];
  for (const [i, step] of steps.entries()) {
    report.failed = await step.run();
    if (report.failed) {
      report.not_attempted = steps.slice(i + 1).map((s) => s.tag);
      throw new PushError(`push: stopped at ${step.tag}: ${report.failed.error}`, report);
    }
  }
  return report;
}
