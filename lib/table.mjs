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

export function planTable(plan) {
  const out = [`# FreshBooks entries for business ${plan.business_id} (${plan.timezone})`, ''];
  const total = (entries) => hours(entries.reduce((sum, e) => sum + e.billable_hours, 0));
  const byRepo = new Map();
  for (const entry of [...plan.create].sort((a, b) => Date.parse(a.first_work) - Date.parse(b.first_work) || a.tag.localeCompare(b.tag))) {
    const key = entry.repo.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), entry]);
  }
  for (const entries of byRepo.values()) {
    out.push(`## ${entries[0].repo}`, '', '| Date | Note | Hours | Source | Client | Project | Service |', '|---|---|---:|---|---:|---:|---:|');
    for (const { date, source, billable_hours: h, time_entry: t } of entries) {
      out.push(`| ${date} | ${cell(t.note)} | ${hours(h)} | ${source === 'git' ? 'git (fallback)' : 'session'} | ${t.client_id} | ${t.project_id} | ${t.service_id} |`);
    }
    out.push(`| | **Total** | ${total(entries)} | | | | |`, '');
  }
  if (plan.create.length) {
    out.push(`To create: ${plan.create.length} entries, ${total(plan.create)} h.`, '');
  } else {
    out.push('Nothing new to create.', '');
  }
  if (plan.skip.length) {
    out.push('Already in FreshBooks, skipped:', '');
    for (const s of plan.skip) out.push(`- ${cell(s.label)} \`${s.tag}\` (entry ${s.existing_id})`);
    out.push('');
  }
  if (plan.create.length) out.push(`Approval code: ${plan.approval}`);
  return `${out.join('\n').trimEnd()}\n`;
}
