const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const hours = (value) => value.toFixed(2);

export function reviewTable(result) {
  const out = [`# Time estimate ${result.range.from} to ${result.range.to} (${result.range.timezone})`, ''];
  for (const repo of result.repos) {
    out.push(`## ${repo.repo}`, '', '| Date | Item | AI h | Billable h | Source | Tag |', '|---|---|---:|---:|---|---|');
    for (const line of repo.lines) {
      const source = line.source === 'git' ? 'git (fallback)' : 'session';
      out.push(`| ${line.date} | ${cell(line.label)} | ${hours(line.ai_hours)} | ${hours(line.billable_hours)} | ${source} | \`${line.tag}\` |`);
    }
    out.push(`| | **Total** | ${hours(repo.ai_hours)} | ${hours(repo.billable_hours)} | | |`, '');
  }
  if (result.repos.length === 0) out.push('No billable activity in this range.', '');
  if (result.unattributed.ai_hours > 0) {
    out.push(`Unattributed session time: ${hours(result.unattributed.ai_hours)} AI h (no GitHub repo resolved).`, '');
  }
  for (const warning of result.warnings) out.push(`Warning: ${warning}`);
  return `${out.join('\n').trimEnd()}\n`;
}

const RATE = { 'flat-rate': 'flat-rate (saved mark)', hourly: 'hourly' };
const change = (u, key) => (key in u.to ? `${u.from[key] ?? 'none'} → ${u.to[key]}` : 'unchanged');
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function planTable(plan) {
  const out = [`# FreshBooks entries for business ${plan.business_id} (${plan.timezone})`, ''];
  const total = (entries) => hours(entries.reduce((sum, e) => sum + e.billable_hours, 0));
  const byRepo = new Map();
  for (const entry of [...plan.create].sort((a, b) => Date.parse(a.first_work) - Date.parse(b.first_work) || a.tag.localeCompare(b.tag))) {
    const key = entry.repo.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), entry]);
  }
  for (const entries of byRepo.values()) {
    out.push(`## ${entries[0].repo}`, '', '| Date | Note | Hours | Rate | Source | Client | Project | Service |', '|---|---|---:|---|---|---:|---:|---:|');
    for (const { date, source, rate, billable_hours: h, time_entry: t } of entries) {
      out.push(`| ${date} | ${cell(t.note)} | ${hours(h)} | ${RATE[rate]} | ${source === 'git' ? 'git (fallback)' : 'session'} | ${t.client_id} | ${t.project_id} | ${t.service_id ?? 'none'} |`);
    }
    out.push(`| | **Total** | ${total(entries)} | | | | | |`, '');
  }
  if (plan.update.length) {
    out.push('## Existing entries to update', '', '| Date | Note | Hours | Rate | Entry | Client | Project | Billable | Service |', '|---|---|---:|---|---:|---:|---:|---|---|');
    for (const u of [...plan.update].sort((a, b) => a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag))) {
      out.push(`| ${u.date} | ${cell(u.time_entry.note)} | ${u.hours === null ? 'unknown' : hours(u.hours)} | ${RATE[u.rate]} | ${u.id} | ${cell(u.time_entry.client_id)} | ${cell(u.time_entry.project_id)} | ${change(u, 'billable')} | ${change(u, 'service_id')} |`);
    }
    out.push('');
  }
  if (plan.create.length) {
    const hourly = plan.create.filter((e) => e.rate === 'hourly');
    const flat = plan.create.filter((e) => e.rate === 'flat-rate');
    out.push(`To create: ${count(plan.create.length, 'entry', 'entries')}, ${total(plan.create)} h, all billable: ${total(hourly)} h hourly, ${total(flat)} h flat-rate.`, '');
  }
  if (plan.update.length) {
    const billable = plan.update.filter((u) => 'billable' in u.to).length;
    const service = plan.update.filter((u) => 'service_id' in u.to).length;
    out.push(`To update: ${count(plan.update.length, 'existing entry', 'existing entries')}, ${count(billable, 'billable change')} and ${count(service, 'service change')}. Duration, date and note stay as they are.`, '');
  }
  if (!plan.create.length && !plan.update.length) out.push('Nothing to create or update.', '');
  if (plan.skip.length) {
    out.push(`Already in FreshBooks and unchanged, skipped: ${count(plan.skip.length, 'entry', 'entries')}.`, '');
    for (const s of plan.skip) out.push(`- ${cell(s.label)} \`${s.tag}\` (entry ${s.existing_id}, ${RATE[s.rate]})`);
    out.push('');
  }
  for (const b of plan.blocked) out.push(`Cannot ${b.action}: ${b.reason}.`);
  if (plan.blocked.length) out.push('', 'No approval code until every "Cannot" line above is fixed.');
  else if (plan.create.length || plan.update.length) out.push(`Approval code: ${plan.approval}`);
  return `${out.join('\n').trimEnd()}\n`;
}
