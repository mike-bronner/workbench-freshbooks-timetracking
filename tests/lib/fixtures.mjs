import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const TZ = 'America/Phoenix';

export const at = (local) => new Date(`${local.replace(' ', 'T')}-07:00`).toISOString();

export const config = (overrides = {}) => ({
  human_minutes_per_ai_hour: 20,
  idle_gap_minutes: 15,
  rounding_step_hours: 0.25,
  timezone: TZ,
  authors: ['mikebronner'],
  ...overrides,
});

export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'wbft-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function gitRepo(path, remote) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
  return path;
}

let counter = 0;

export function transcript(path, { sessionId, cwd, branch = null, prompt = null, times, agentId = null }) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = times.map((time, i) => JSON.stringify({
    type: i === 0 ? 'user' : 'assistant',
    uuid: `uuid-${++counter}`,
    timestamp: at(time),
    cwd,
    gitBranch: branch,
    sessionId,
    isSidechain: agentId !== null,
    agentId,
    message: i === 0 && prompt ? { role: 'user', content: prompt } : { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  }));
  writeFileSync(path, `${lines.join('\n')}\n`);
  return lines;
}

export const pr = ({ repo = 'acme/widgets', number = 1, commits = [], linkedIssue = null, ...fields }) => ({
  __typename: 'PullRequest',
  number,
  title: 'A pull request',
  url: `https://github.com/${repo}/pull/${number}`,
  headRefName: 'feature',
  createdAt: '2026-10-01T00:00:00Z',
  closedAt: null,
  updatedAt: '2026-10-20T00:00:00Z',
  ...fields,
  closingIssuesReferences: { nodes: linkedIssue ? [{ repository: { nameWithOwner: repo }, ...linkedIssue }] : [] },
  repository: { nameWithOwner: repo },
  commits: {
    totalCount: commits.length,
    nodes: commits.map((c) => {
      const { t, login = 'mikebronner', email = null } = typeof c === 'string' ? { t: c } : c;
      return { commit: { authoredDate: at(t), author: { email, user: login ? { login } : null } } };
    }),
  },
});

export const issue = (number, title, updatedAt = '2026-10-20T00:00:00Z') => ({
  __typename: 'Issue', number, title, updatedAt, url: `https://github.com/acme/widgets/issues/${number}`,
});

export function fakeGh({ prs = [], refs = {} }) {
  const calls = [];
  const gh = (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('search(')) {
      const updated = /updated:>=(\S+)/.exec(variables.q)[1];
      const created = /created:<=(\S+)/.exec(variables.q)[1];
      const repo = /repo:(\S+)/.exec(variables.q)?.[1];
      const hits = prs.filter((p) => p.updatedAt.slice(0, 10) >= updated && p.createdAt.slice(0, 10) <= created)
        .filter((p) => !repo || p.repository.nameWithOwner === repo);
      return { data: { search: { issueCount: hits.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: hits } } };
    }
    const repo = `${variables.owner}/${variables.name}`;
    const known = refs[repo] ?? {};
    const fields = Object.fromEntries([...query.matchAll(/n(\d+): issueOrPullRequest/g)].map(([, n]) => [`n${n}`, known[n] ?? null]));
    return { data: { repository: fields } };
  };
  gh.calls = calls;
  return gh;
}
