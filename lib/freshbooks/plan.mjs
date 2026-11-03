import { createHash } from 'node:crypto';

import { REPO } from '../config.mjs';
import { addDays, isDate, localDate, zonedMidnight } from '../time.mjs';
import { createTimeEntry, listTimeEntries } from './api.mjs';

const TAG = /^\[wbi:[a-z0-9_.-]+\/[a-z0-9_.-]+(?:#\d+)?:\d{4}-\d{2}-\d{2}\]$/;

export class ApprovalError extends Error {}

export class PushError extends Error {
  constructor(message, report) {
    super(message);
    this.report = report;
  }
}

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

export function entriesFor(lines, settings, timezone) {
  const unmapped = [...new Set(lines.filter((l) => !settings.repos[l.repo.toLowerCase()]).map((l) => l.repo))];
  if (unmapped.length) throw new Error(`plan: no FreshBooks mapping for ${unmapped.join(', ')}; save one with bin/map.sh`);
  return lines.map((line) => {
    const map = settings.repos[line.repo.toLowerCase()];
    return {
      tag: line.tag,
      repo: line.repo,
      date: line.date,
      label: line.label,
      billable_hours: line.billable_hours,
      time_entry: {
        is_logged: true,
        duration: durationOf(line),
        started_at: startedAt(line, timezone),
        note: `${line.label} ${line.tag}`,
        billable: true,
        client_id: map.client_id,
        project_id: map.project_id,
        service_id: map.service_id,
      },
    };
  });
}

export const approvalCode = (businessId, create) => createHash('sha256')
  .update(JSON.stringify({ business_id: businessId, create: create.map((e) => [e.tag, e.time_entry]) }))
  .digest('hex')
  .slice(0, 16);

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
  const notes = existing.map((e) => ({ id: e?.id ?? null, note: String(e?.note ?? '').toLowerCase() }));
  const create = [];
  const skip = [];
  for (const entry of entries) {
    const hit = notes.find((n) => n.note.includes(entry.tag));
    if (hit) skip.push({ tag: entry.tag, label: entry.label, existing_id: hit.id });
    else create.push(entry);
  }
  return { business_id: settings.business_id, timezone, approval: approvalCode(settings.business_id, create), create, skip };
}

const notCreatedStatus = (error) => (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 408 ? 'no' : 'unknown');

export async function push({ client, plan, approval }) {
  if (typeof approval !== 'string' || approval !== plan.approval) {
    throw new ApprovalError('push: the approval code does not match the current plan; nothing was created. Run bin/plan.sh and review again');
  }
  const report = { business_id: plan.business_id, created: [], skipped: plan.skip, failed: null, not_attempted: [] };
  for (const [i, entry] of plan.create.entries()) {
    let made;
    try {
      made = (await createTimeEntry(client, plan.business_id, entry.time_entry))?.time_entry;
    } catch (error) {
      report.failed = { tag: entry.tag, created: notCreatedStatus(error), error: error.message };
    }
    if (!report.failed && !made?.id) {
      report.failed = { tag: entry.tag, created: 'unknown', error: 'the response carries no time_entry id; check FreshBooks before a rerun' };
    }
    if (!report.failed) {
      report.created.push({ tag: entry.tag, id: made.id });
      if (!String(made.note ?? '').toLowerCase().includes(entry.tag)) {
        report.failed = { tag: entry.tag, created: 'yes', error: `FreshBooks stored entry ${made.id} without its tag in the note, so a rerun cannot detect it` };
      }
    }
    if (report.failed) {
      report.not_attempted = plan.create.slice(i + 1).map((e) => e.tag);
      throw new PushError(`push: stopped at ${entry.tag}: ${report.failed.error}`, report);
    }
  }
  return report;
}
