import { execFileSync } from 'node:child_process';

import { addDays } from '../time.mjs';

const SEARCH_LIMIT = 1000;
const REF_BATCH = 50;
const SEARCH_PAGE = 25;
const GH_ATTEMPTS = 3;

const PR_FIELDS = `number title url headRefName createdAt closedAt updatedAt
  repository { nameWithOwner }
  closingIssuesReferences(first: 1) { nodes { number title repository { nameWithOwner } } }`;

export const searchQualifier = (login) =>
  login.endsWith('[bot]') ? `author:app/${login.slice(0, -'[bot]'.length)}` : `author:${login}`;

const ghOnce = (args) => {
  let stdout;
  try {
    stdout = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    stdout = error.stdout;
    if (!stdout) throw new Error(`gh: ${String(error.stderr || error.message).trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

export function runGh(query, variables = {}, once = ghOnce) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) args.push('-f', `${key}=${value}`);
  }
  let response = null;
  for (let attempt = 0; attempt < GH_ATTEMPTS && response === null; attempt++) response = once(args);
  if (response === null) throw new Error(`gh: GitHub sent no JSON after ${GH_ATTEMPTS} attempts`);
  if (!response.data) throw new Error(`gh: ${JSON.stringify(response.errors ?? response)}`);
  return response;
}

const COMMITS = 'commits(first: 100) { totalCount nodes { commit { authoredDate author { email user { login } } } } }';

const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

export const commitLogin = (author) => author?.user?.login ?? NOREPLY.exec(author?.email ?? '')?.[1] ?? null;

const linked = (issue, repo) => issue && { number: issue.number, title: issue.title, repo: issue.repository?.nameWithOwner ?? repo };

const pullRequest = (node) => ({
  repo: node.repository.nameWithOwner,
  number: node.number,
  title: node.title,
  url: node.url,
  headRefName: node.headRefName,
  createdAt: Date.parse(node.createdAt),
  closedAt: node.closedAt ? Date.parse(node.closedAt) : null,
  updatedAt: Date.parse(node.updatedAt),
  linkedIssue: linked(node.closingIssuesReferences?.nodes?.[0], node.repository.nameWithOwner),
  commits: (node.commits?.nodes ?? []).map((c) => Date.parse(c.commit.authoredDate)),
  authored: (node.commits?.nodes ?? []).map((c) => ({ t: Date.parse(c.commit.authoredDate), login: commitLogin(c.commit.author) })),
  commitCount: node.commits?.totalCount ?? 0,
});

function searchAll(q, gh) {
  const query = `query($q: String!, $after: String) {
    search(type: ISSUE, query: $q, first: ${SEARCH_PAGE}, after: $after) {
      issueCount pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${PR_FIELDS} ${COMMITS} } }
    }
  }`;
  const prs = [];
  let after = null;
  do {
    const { search } = gh(query, { q, after }).data;
    if (search.issueCount > SEARCH_LIMIT) {
      throw new Error(`github: ${search.issueCount} PRs match "${q}", above the search limit of ${SEARCH_LIMIT}; use a shorter range`);
    }
    for (const node of search.nodes) if (node?.number) prs.push(pullRequest(node));
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return prs;
}

const rangeQualifiers = (from, to) => `updated:>=${addDays(from, -1)} created:<=${addDays(to, 1)}`;

function unique(lists) {
  const prs = new Map();
  for (const pr of lists.flat()) prs.set(`${pr.repo}#${pr.number}`, pr);
  return [...prs.values()];
}

export const searchPullRequests = ({ authors, from, to }, gh = runGh) =>
  unique(authors.map((author) => searchAll(`is:pr ${searchQualifier(author)} ${rangeQualifiers(from, to)}`, gh)));

export const searchRepoPullRequests = ({ repos, from, to }, gh = runGh) =>
  unique(repos.map((repo) => searchAll(`is:pr repo:${repo} ${rangeQualifiers(from, to)}`, gh)));

export function lookupRefs(refsByRepo, gh = runGh) {
  const found = new Map();
  for (const [repo, numbers] of refsByRepo) {
    const [owner, name] = repo.split('/');
    const list = [...numbers];
    for (let i = 0; i < list.length; i += REF_BATCH) {
      const fields = list.slice(i, i + REF_BATCH).map((n) => `n${n}: issueOrPullRequest(number: ${Number(n)}) {
        __typename ... on PullRequest { ${PR_FIELDS} } ... on Issue { number title url updatedAt } }`).join('\n');
      const { data } = gh(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner, name });
      for (const node of Object.values(data.repository ?? {})) {
        if (!node?.number) continue;
        found.set(`${repo.toLowerCase()}#${node.number}`, node.__typename === 'PullRequest'
          ? { type: 'pr', ...pullRequest(node) }
          : { type: 'issue', repo, number: node.number, title: node.title, url: node.url, updatedAt: Date.parse(node.updatedAt) });
      }
    }
  }
  return found;
}
