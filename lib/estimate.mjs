import { addDays, localDate, splitAtMidnight, zonedMidnight } from './time.mjs';

const REF = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)\b|(?<![\w/&#])#(\d+)\b/g;
const IMAGE_MARKER = /\[Image #\d+\]/g;
const REFS_PER_AGENT = 3;
const HOUR_MS = 3600000;

export function extractRefs(text) {
  const refs = [];
  for (const m of text.replace(IMAGE_MARKER, '').matchAll(REF)) {
    if (m[3]) refs.push({ repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
    else if (m[6]) refs.push({ repo: `${m[4]}/${m[5]}`, number: Number(m[6]) });
    else refs.push({ repo: null, number: Number(m[7]) });
  }
  return refs;
}

const key = (repo) => repo.toLowerCase();

export const tagFor = ({ repo, date, kind, pr, issue }) =>
  kind === 'general' ? `[wbi:${key(repo)}:${date}]` : `[wbi:${key(repo)}#${kind === 'pr' ? pr : issue}:${date}]`;

const labelFor = (line) => {
  if (line.kind === 'general') return 'General development';
  if (line.kind === 'issue') return `Issue #${line.issue}: ${line.title}`;
  const issue = line.linkedIssue;
  if (!issue) return `PR #${line.pr}: ${line.title}`;
  const ref = key(issue.repo) === key(line.repo) ? `#${issue.number}` : `${issue.repo}#${issue.number}`;
  return `Issue ${ref}: ${issue.title} (PR #${line.pr})`;
};

export const billableHours = (activeMs, config) => {
  const stepMs = config.rounding_step_hours * HOUR_MS;
  return Math.ceil((activeMs * config.human_minutes_per_ai_hour) / (60 * stepMs)) * config.rounding_step_hours;
};

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

function pieces(start, end, range, tz) {
  if (end <= range.startMs || start >= range.endMs) return [];
  return splitAtMidnight(start, end, tz).filter((p) => p.date >= range.from && p.date <= range.to);
}

function sessionSegments(agents, resolveRepo, range, config) {
  const idleMs = config.idle_gap_minutes * 60000;
  const segments = [];
  const unattributed = new Map();
  for (const agent of agents) {
    for (let i = 0; i + 1 < agent.points.length; i++) {
      const a = agent.points[i];
      const b = agent.points[i + 1];
      const gap = b.t - a.t;
      if (gap <= 0 || gap > idleMs) continue;
      for (const piece of pieces(a.t, b.t, range, config.timezone)) {
        const repo = resolveRepo(a.cwd, a.branch);
        if (repo) {
          segments.push({ ...piece, agent, repo, branch: a.branch });
        } else {
          const cwd = a.cwd ?? '(no cwd)';
          unattributed.set(cwd, (unattributed.get(cwd) ?? 0) + piece.end - piece.start);
        }
      }
    }
  }
  return { segments, unattributed };
}

function gitSegments(pr, range, config) {
  const idleMs = config.idle_gap_minutes * 60000;
  const commits = pr.commits.filter((t) => t >= range.startMs && t < range.endMs).sort((a, b) => a - b);
  return commits.flatMap((t, i) => {
    const previous = commits[i - 1];
    const start = previous !== undefined && t - previous <= idleMs ? previous : t - idleMs;
    return start < t ? pieces(start, t, range, config.timezone) : [];
  });
}

function prIndex(prs) {
  const index = new Map();
  for (const pr of prs) {
    const branches = index.get(key(pr.repo)) ?? new Map();
    branches.set(pr.headRefName, [...(branches.get(pr.headRefName) ?? []), pr].sort((a, b) => a.createdAt - b.createdAt));
    index.set(key(pr.repo), branches);
  }
  return index;
}

const matchBranch = (index, repo, branch, t) => {
  const candidates = branch ? index.get(key(repo))?.get(branch) : null;
  if (!candidates) return null;
  return candidates.find((pr) => pr.closedAt === null || pr.closedAt >= t) ?? candidates.at(-1);
};

export function buildRange(from, to, tz) {
  return { from, to, startMs: zonedMidnight(from, tz), endMs: zonedMidnight(addDays(to, 1), tz) };
}

export function branchIndexOf(prs) {
  const index = new Map();
  for (const pr of prs) index.set(pr.headRefName, new Set([...(index.get(pr.headRefName) ?? []), pr.repo]));
  return index;
}

export function estimate({ agents, prs, resolveRepo, lookupRefs, config, range, repos = null }) {
  const wanted = repos && new Set(repos.map(key));
  const keep = (repo) => !wanted || wanted.has(key(repo));
  const index = prIndex(prs);
  const { segments: all, unattributed } = sessionSegments(agents, resolveRepo, range, config);
  const segments = all.filter((s) => keep(s.repo));

  for (const s of segments) s.pr = matchBranch(index, s.repo, s.branch, s.start);

  const refsOf = new Map();
  const mainOf = new Map(agents.filter((a) => a.agentId === 'main').map((a) => [a.sessionId, a]));
  const agentRefs = (agent) => {
    if (!refsOf.has(agent)) {
      const own = agent.prompts.flatMap(extractRefs);
      const parent = agent.agentId === 'main' ? [] : (mainOf.get(agent.sessionId)?.prompts ?? []).flatMap(extractRefs);
      refsOf.set(agent, [...own, ...parent]);
    }
    return refsOf.get(agent);
  };
  const candidates = (agent, repo) => [...new Set(agentRefs(agent)
    .filter((r) => r.repo === null || key(r.repo) === key(repo))
    .map((r) => r.number))].slice(0, REFS_PER_AGENT);

  const wantedRefs = new Map();
  for (const s of segments.filter((x) => !x.pr)) {
    const set = wantedRefs.get(s.repo) ?? new Set();
    for (const n of candidates(s.agent, s.repo)) set.add(n);
    if (set.size) wantedRefs.set(s.repo, set);
  }
  const found = wantedRefs.size ? lookupRefs(wantedRefs) : new Map();
  const knownPrs = [...prs, ...[...found.values()].filter((r) => r.type === 'pr')];
  const closing = new Map();
  for (const pr of knownPrs) if (pr.linkedIssue && key(pr.linkedIssue.repo) === key(pr.repo)) closing.set(`${key(pr.repo)}#${pr.linkedIssue.number}`, pr);

  for (const s of segments.filter((x) => !x.pr)) {
    const ref = candidates(s.agent, s.repo).map((n) => found.get(`${key(s.repo)}#${n}`)).find((r) => r && r.updatedAt >= range.startMs);
    if (ref?.type === 'pr') s.pr = ref;
    else if (ref) s.pr = closing.get(`${key(s.repo)}#${ref.number}`) ?? null;
    if (ref && !s.pr) s.issue = ref;
  }

  const lines = new Map();
  const add = (piece, fields) => {
    const id = `${key(fields.repo)}|${piece.date}|${fields.kind}|${fields.pr ?? fields.issue ?? ''}`;
    const line = lines.get(id) ?? { ...fields, date: piece.date, activeMs: 0, first: piece.start };
    line.activeMs += piece.end - piece.start;
    line.first = Math.min(line.first, piece.start);
    lines.set(id, line);
  };
  const prFields = (pr, source) => ({
    repo: pr.repo, kind: 'pr', pr: pr.number, issue: pr.linkedIssue?.number ?? null, issue_repo: pr.linkedIssue?.repo ?? null,
    title: pr.title, url: pr.url, linkedIssue: pr.linkedIssue, source,
  });

  const covered = new Set();
  for (const s of segments) {
    if (s.pr) {
      covered.add(`${key(s.pr.repo)}#${s.pr.number}`);
      add(s, prFields(s.pr, 'session'));
    } else if (s.issue) {
      add(s, { repo: s.repo, kind: 'issue', pr: null, issue: s.issue.number, title: s.issue.title, url: s.issue.url, source: 'session' });
    } else {
      add(s, { repo: s.repo, kind: 'general', pr: null, issue: null, title: null, url: null, source: 'session' });
    }
  }
  const warnings = [];
  for (const pr of prs.filter((p) => keep(p.repo) && !covered.has(`${key(p.repo)}#${p.number}`))) {
    if (pr.commitCount > pr.commits.length) warnings.push(`${pr.repo}#${pr.number}: only the first ${pr.commits.length} of ${pr.commitCount} commits were read`);
    for (const piece of gitSegments(pr, range, config)) add(piece, prFields(pr, 'git'));
  }

  const grouped = new Map();
  for (const line of [...lines.values()].sort((a, b) => a.first - b.first)) {
    const group = grouped.get(key(line.repo)) ?? { repo: line.repo, org: line.repo.split('/')[0], first: line.first, activeMs: 0, lines: [] };
    group.activeMs += line.activeMs;
    group.lines.push({
      repo: line.repo,
      date: line.date,
      kind: line.kind,
      pr: line.pr,
      issue: line.issue,
      issue_repo: line.issue_repo ?? (line.kind === 'issue' ? line.repo : null),
      label: labelFor(line),
      url: line.url,
      source: line.source,
      active_seconds: Math.round(line.activeMs / 1000),
      ai_hours: round(line.activeMs / HOUR_MS, 2),
      billable_hours: billableHours(line.activeMs, config),
      first_work: new Date(line.first).toISOString(),
      tag: tagFor({ ...line }),
    });
    grouped.set(key(line.repo), group);
  }

  const unattributedMs = [...unattributed.values()].reduce((sum, ms) => sum + ms, 0);
  return {
    range: { from: range.from, to: range.to, timezone: config.timezone },
    settings: {
      human_minutes_per_ai_hour: config.human_minutes_per_ai_hour,
      idle_gap_minutes: config.idle_gap_minutes,
      rounding_step_hours: config.rounding_step_hours,
    },
    repos: [...grouped.values()].map((g) => ({
      repo: g.repo,
      org: g.org,
      first_work: new Date(g.first).toISOString(),
      ai_hours: round(g.activeMs / HOUR_MS, 2),
      billable_hours: g.lines.reduce((sum, l) => sum + l.billable_hours, 0),
      active_seconds: Math.round(g.activeMs / 1000),
      lines: g.lines,
    })),
    unattributed: {
      ai_hours: round(unattributedMs / HOUR_MS, 2),
      top_cwds: [...unattributed].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([cwd, ms]) => ({ cwd, ai_hours: round(ms / HOUR_MS, 2) })),
    },
    warnings,
  };
}

export function repoChoices(result) {
  const repos = [...result.repos].sort((a, b) => b.active_seconds - a.active_seconds || a.repo.localeCompare(b.repo)).map((r) => ({
    repo: r.repo,
    org: r.org,
    label: r.repo,
    description: `${r.ai_hours} AI h, ${r.billable_hours} billable h, ${r.lines.length} line(s), first work ${localDate(Date.parse(r.first_work), result.range.timezone)}`,
    ai_hours: r.ai_hours,
    billable_hours: r.billable_hours,
    first_work: r.first_work,
  }));
  const orgs = new Map();
  for (const r of repos) {
    const org = orgs.get(r.org) ?? { org: r.org, ai_hours: 0, repos: [] };
    org.ai_hours = round(org.ai_hours + r.ai_hours, 2);
    org.repos.push(r.repo);
    orgs.set(r.org, org);
  }
  return {
    range: result.range,
    repos,
    orgs: [...orgs.values()].sort((a, b) => b.ai_hours - a.ai_hours || a.org.localeCompare(b.org)),
    unattributed: result.unattributed,
    warnings: result.warnings,
  };
}
