import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { lookupRefs, runGh, searchPullRequests, searchQualifier } from '../lib/collect/github.mjs';
import { createResolver, parseGithubRemote } from '../lib/collect/resolve.mjs';
import { readTranscript } from '../lib/collect/sessions.mjs';
import { loadConfig, normalizeConfig } from '../lib/config.mjs';
import { billableHours, buildRange, estimate, extractRefs, tagFor } from '../lib/estimate.mjs';
import { isDate, splitAtMidnight, zonedMidnight } from '../lib/time.mjs';
import { at, config, issue, pr, sandbox } from './lib/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('time', () => {
  it('finds local midnight across a DST change', () => {
    assert.equal(new Date(zonedMidnight('2026-11-01', 'America/New_York')).toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(new Date(zonedMidnight('2026-11-02', 'America/New_York')).toISOString(), '2026-11-02T05:00:00.000Z');
    assert.equal(new Date(zonedMidnight('2026-10-14', 'America/Phoenix')).toISOString(), '2026-10-14T07:00:00.000Z');
  });

  it('splits an interval at local midnight', () => {
    const start = Date.parse('2026-10-15T06:52:00Z');
    const end = Date.parse('2026-10-15T07:02:00Z');
    assert.deepEqual(splitAtMidnight(start, end, 'America/Phoenix'), [
      { start, end: Date.parse('2026-10-15T07:00:00Z'), date: '2026-10-14' },
      { start: Date.parse('2026-10-15T07:00:00Z'), end, date: '2026-10-15' },
    ]);
    assert.deepEqual(splitAtMidnight(start, end, 'UTC'), [{ start, end, date: '2026-10-15' }]);
  });

  it('accepts only real calendar dates', () => {
    assert.equal(isDate('2026-10-31'), true);
    assert.equal(isDate('2026-02-30'), false);
    assert.equal(isDate('2026-1-01'), false);
    assert.equal(isDate(undefined), false);
  });
});

describe('config', () => {
  it('fills defaults and keeps the configured timezone', () => {
    const result = normalizeConfig({ authors: ['mikebronner'], timezone: 'America/Phoenix' });
    assert.equal(result.human_minutes_per_ai_hour, 20);
    assert.equal(result.idle_gap_minutes, 15);
    assert.equal(result.rounding_step_hours, 0.25);
    assert.equal(result.timezone, 'America/Phoenix');
  });

  it('falls back to the system timezone', () => {
    assert.equal(normalizeConfig({ authors: ['a'] }).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  for (const [name, raw] of [
    ['a non-object', []],
    ['a zero ratio', { authors: ['a'], human_minutes_per_ai_hour: 0 }],
    ['a negative idle gap', { authors: ['a'], idle_gap_minutes: -1 }],
    ['an idle gap over a day', { authors: ['a'], idle_gap_minutes: 1441 }],
    ['a string rounding step', { authors: ['a'], rounding_step_hours: '0.25' }],
    ['a rounding step of a fraction of a second', { authors: ['a'], rounding_step_hours: 0.0000001 }],
    ['no authors', { authors: [] }],
    ['a missing author list', {}],
    ['a malformed login', { authors: ['bad login'] }],
    ['an unknown timezone', { authors: ['a'], timezone: 'Mars/Olympus' }],
  ]) {
    it(`refuses ${name}`, () => assert.throws(() => normalizeConfig(raw), /^Error: config:/));
  }

  it('refuses a missing or malformed file', () => {
    const box = sandbox();
    try {
      assert.throws(() => loadConfig(join(box.root, 'none.json')), /cannot read/);
      writeFileSync(join(box.root, 'bad.json'), '{');
      assert.throws(() => loadConfig(join(box.root, 'bad.json')), /not valid JSON/);
    } finally {
      box.cleanup();
    }
  });
});

describe('hours', () => {
  it('rounds billable hours up to the step, exactly on a boundary', () => {
    const c = config();
    assert.equal(billableHours(45 * 60000, c), 0.25);
    assert.equal(billableHours(45 * 60000 + 1, c), 0.5);
    assert.equal(billableHours(1000, c), 0.25);
    assert.equal(billableHours(0, c), 0);
    assert.equal(billableHours(60 * 60000, config({ human_minutes_per_ai_hour: 60, rounding_step_hours: 0.1 })), 1);
  });

  it('tags PR, issue and general lines in stable forms', () => {
    assert.equal(tagFor({ repo: 'o/r', date: '2026-10-14', kind: 'pr', pr: 123, issue: 7 }), '[wbi:o/r#123:2026-10-14]');
    assert.equal(tagFor({ repo: 'o/r', date: '2026-10-14', kind: 'issue', pr: null, issue: 7 }), '[wbi:o/r#7:2026-10-14]');
    assert.equal(tagFor({ repo: 'o/r', date: '2026-10-14', kind: 'general', pr: null, issue: null }), '[wbi:o/r:2026-10-14]');
  });
});

describe('refs', () => {
  it('finds URL, qualified and bare references in text order', () => {
    assert.deepEqual(extractRefs('see https://github.com/o/r/pull/5, then o/s#6 and #7 (#8)'), [
      { repo: 'o/r', number: 5 }, { repo: 'o/s', number: 6 }, { repo: null, number: 7 }, { repo: null, number: 8 },
    ]);
  });

  it('ignores HTML entities, anchors, headings and pasted-image markers', () => {
    assert.deepEqual(extractRefs('it&#39;s page#2 ## 3 and #12x [Image #4]'), []);
  });
});

describe('github', () => {
  it('turns a bot login into an app search qualifier', () => {
    assert.equal(searchQualifier('dr-john-h-watson[bot]'), 'author:app/dr-john-h-watson');
    assert.equal(searchQualifier('mikebronner'), 'author:mikebronner');
  });

  const page = (nodes, next = null, issueCount = nodes.length) => ({
    data: { search: { issueCount, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } },
  });

  it('pages through search results and merges authors', () => {
    const calls = [];
    const gh = (_q, vars) => {
      calls.push(vars);
      if (vars.q.includes('app/x') ) return page([pr({ number: 2 })]);
      return vars.after ? page([pr({ number: 2 })]) : page([pr({ number: 1, linkedIssue: { number: 9, title: 'T' } })], 'c1');
    };
    const prs = searchPullRequests({ authors: ['me', 'x[bot]'], from: '2026-10-01', to: '2026-10-31' }, gh);
    assert.deepEqual(prs.map((p) => [p.repo, p.number, p.linkedIssue?.number ?? null]), [['acme/widgets', 1, 9], ['acme/widgets', 2, null]]);
    assert.deepEqual(calls.map((c) => c.after ?? null), [null, 'c1', null]);
  });

  it('refuses a result above the search limit', () => {
    assert.throws(() => searchPullRequests({ authors: ['me'], from: '2026-01-01', to: '2026-12-31' }, () => page([], null, 1001)), /search limit/);
  });

  it('looks up references as PRs or issues and skips unknown numbers', () => {
    const gh = () => ({ data: { repository: { n5: pr({ number: 5, title: 'P' }), n6: issue(6, 'I'), n7: null } } });
    const found = lookupRefs(new Map([['Acme/Widgets', new Set([5, 6, 7])]]), gh);
    assert.equal(found.get('acme/widgets#5').type, 'pr');
    assert.equal(found.get('acme/widgets#6').type, 'issue');
    assert.equal(found.has('acme/widgets#7'), false);
  });
});

describe('repo resolution', () => {
  it('parses GitHub remotes in each form', () => {
    assert.equal(parseGithubRemote('git@github.com:acme/widgets.git'), 'acme/widgets');
    assert.equal(parseGithubRemote('https://github.com/acme/widgets'), 'acme/widgets');
    assert.equal(parseGithubRemote('ssh://git@github.com/acme/wid.gets.git/'), 'acme/wid.gets');
    assert.equal(parseGithubRemote('git@gitlab.com:acme/widgets.git'), null);
  });

  it('follows a remote that is a local clone path', () => {
    const remotes = { [ROOT]: '/', '/': 'https://github.com/acme/widgets.git' };
    const resolve = createResolver({ projectsDir: ROOT, git: (cwd) => remotes[cwd] ?? null });
    assert.equal(resolve(ROOT, null), 'acme/widgets');
  });

  it('matches a vanished path by a unique repo name, and refuses an ambiguous one', () => {
    const resolve = createResolver({ projectsDir: ROOT, knownRepos: ['acme/widgets', 'acme/tools', 'other/tools'], git: () => null });
    assert.equal(resolve('/gone/worktrees/Widgets/fix', null), 'acme/widgets');
    assert.equal(resolve('/gone/tools/fix', null), null);
  });

  it('falls back to a PR head branch found in only one repo', () => {
    const branchIndex = new Map([['fix-a', new Set(['acme/widgets'])], ['main-ish', new Set(['acme/widgets', 'acme/tools'])]]);
    const resolve = createResolver({ projectsDir: ROOT, branchIndex, git: () => null });
    assert.equal(resolve('/gone/x', 'fix-a'), 'acme/widgets');
    assert.equal(resolve('/gone/x', 'main-ish'), null);
  });

  it('returns GitHub casing for a remote that differs only in case', () => {
    const resolve = createResolver({ projectsDir: ROOT, knownRepos: ['Acme/Widgets'], git: () => 'git@github.com:acme/widgets.git' });
    assert.equal(resolve(ROOT, null), 'Acme/Widgets');
  });
});

describe('launchers', () => {
  for (const script of ['repos.sh', 'estimate.sh']) {
    it(`${script} refuses bad arguments with usage`, () => {
      const result = spawnSync('bash', [join(ROOT, 'bin', script), '--from', '2026-10-31', '--to', '2026-10-01'], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--from must not be after --to\nusage:/);
    });
  }

  it('estimate.sh refuses an unknown format', () => {
    const result = spawnSync('bash', [join(ROOT, 'bin', 'estimate.sh'), '--from', '2026-10-01', '--to', '2026-10-31', '--format', 'csv'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  });
});

describe('gh runner', () => {
  it('retries a reply that is not JSON, then fails closed', () => {
    let calls = 0;
    const flaky = () => (++calls < 3 ? null : { data: { ok: true } });
    assert.deepEqual(runGh('q', {}, flaky).data, { ok: true });
    assert.equal(calls, 3);
    assert.throws(() => runGh('q', {}, () => null), /no JSON after 3 attempts/);
    assert.throws(() => runGh('q', {}, () => ({ errors: [{ message: 'bad' }] })), /bad/);
  });
});

describe('branch matching', () => {
  it('picks the PR on a reused branch that was open at the time', () => {
    const c = config();
    const range = buildRange('2026-10-01', '2026-10-31', c.timezone);
    const prOn = (number, createdAt, closedAt) => ({
      repo: 'acme/widgets', number, title: `PR ${number}`, url: null, headRefName: 'fix', linkedIssue: null,
      createdAt: Date.parse(createdAt), closedAt: closedAt && Date.parse(closedAt), updatedAt: 0, commits: [], commitCount: 0,
    });
    const agent = (day) => ({
      key: day, sessionId: day, agentId: 'main', prompts: [],
      points: [`${day} 10:00:00`, `${day} 10:05:00`].map((t) => ({ t: Date.parse(at(t)), cwd: '/x', branch: 'fix' })),
    });
    const result = estimate({
      agents: [agent('2026-10-03'), agent('2026-10-12'), agent('2026-10-25')],
      prs: [prOn(2, '2026-10-10T00:00:00Z', null), prOn(1, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z')],
      resolveRepo: () => 'acme/widgets', lookupRefs: () => new Map(), config: c, range,
    });
    assert.deepEqual(result.repos[0].lines.map((l) => [l.date, l.pr]), [['2026-10-03', 1], ['2026-10-12', 2], ['2026-10-25', 2]]);
  });
});

describe('transcript reading', () => {
  it('keeps prompts but drops meta lines and system reminders', async () => {
    const box = sandbox();
    try {
      const path = join(box.root, 's.jsonl');
      const line = (fields) => JSON.stringify({ timestamp: '2026-10-14T17:00:00Z', cwd: '/x', sessionId: 's', ...fields });
      writeFileSync(path, [
        line({ type: 'user', uuid: 'a', isMeta: true, message: { content: 'skill text #5' } }),
        line({ type: 'user', uuid: 'b', message: { content: [{ type: 'text', text: '<system-reminder>#6</system-reminder> fix #7' }, { type: 'tool_result', content: '#8' }] } }),
        line({ type: 'summary', uuid: 'c' }),
        line({ type: 'user', uuid: 'd', message: { content: '<system-reminder>#10</system-reminder> and #11' } }),
      ].join('\n'));
      const [agent] = await readTranscript(path);
      assert.deepEqual(agent.prompts.flatMap(extractRefs).map((r) => r.number), [7, 11]);
      assert.equal(agent.points.length, 3);
    } finally {
      box.cleanup();
    }
  });
});

describe('git fallback', () => {
  it('warns when a PR has more commits than were read', () => {
    const c = config();
    const result = estimate({
      agents: [], resolveRepo: () => null, lookupRefs: () => new Map(), config: c,
      range: buildRange('2026-10-01', '2026-10-31', c.timezone),
      prs: [{ repo: 'acme/widgets', number: 5, title: 'Big', url: null, headRefName: 'big', linkedIssue: null, createdAt: 0, closedAt: null, updatedAt: 0, commits: [Date.parse(at('2026-10-02 10:00:00'))], commitCount: 150 }],
    });
    assert.deepEqual(result.warnings, ['acme/widgets#5: only the first 1 of 150 commits were read']);
    assert.equal(result.repos[0].lines[0].source, 'git');
  });
});

describe('issue to PR join', () => {
  it('does not join a local issue to a PR that closes a same-numbered issue elsewhere', () => {
    const c = config();
    const prOther = {
      repo: 'acme/widgets', number: 3, title: 'Sweep', url: null, headRefName: 'sweep', createdAt: 0, closedAt: null, updatedAt: 0,
      linkedIssue: { number: 9, title: 'Upstream', repo: 'acme/tracker' }, commits: [], commitCount: 0,
    };
    const agent = {
      key: 'a', sessionId: 'a', agentId: 'main', prompts: ['Fix #9'],
      points: ['2026-10-02 10:00:00', '2026-10-02 10:05:00'].map((t) => ({ t: Date.parse(at(t)), cwd: '/x', branch: 'main' })),
    };
    const result = estimate({
      agents: [agent], prs: [prOther], resolveRepo: () => 'acme/widgets', config: c,
      range: buildRange('2026-10-01', '2026-10-31', c.timezone),
      lookupRefs: () => new Map([['acme/widgets#9', { type: 'issue', repo: 'acme/widgets', number: 9, title: 'Local', url: null, updatedAt: Date.parse('2026-10-02T00:00:00Z') }]]),
    });
    assert.deepEqual(result.repos[0].lines.map((l) => [l.kind, l.issue, l.label]), [['issue', 9, 'Issue #9: Local']]);
  });
});

describe('resolution guards', () => {
  it('leaves an existing non-git folder unattributed even when its name matches a repo', () => {
    const box = sandbox();
    try {
      const notes = join(box.root, 'notes', 'api');
      mkdirSync(notes, { recursive: true });
      const resolve = createResolver({ projectsDir: box.root, knownRepos: ['acme/api'], git: () => null });
      assert.equal(resolve(notes, null), null);
      assert.equal(resolve(join(box.root, 'gone', 'api'), null), 'acme/api');
    } finally {
      box.cleanup();
    }
  });

  it('follows a scratchpad to its session, but not through . or ..', () => {
    const box = sandbox();
    try {
      const id = '11111111-2222-3333-4444-555555555555';
      const projects = join(box.root, 'projects');
      mkdirSync(join(projects, 'proj'), { recursive: true });
      writeFileSync(join(projects, 'proj', `${id}.jsonl`), JSON.stringify({ cwd: ROOT }));
      writeFileSync(join(box.root, `${id}.jsonl`), JSON.stringify({ cwd: ROOT }));
      writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({ cwd: ROOT }));
      const resolve = createResolver({ projectsDir: projects, git: (cwd) => (cwd === ROOT ? 'git@github.com:acme/widgets.git' : null) });
      assert.equal(resolve(`/gone/claude-503/proj/${id}/scratchpad`, null), 'acme/widgets');
      assert.equal(resolve(`/gone/claude-503/../${id}/scratchpad`, null), null);
      assert.equal(resolve(`/gone/claude-503/./${id}/scratchpad`, null), null);
    } finally {
      box.cleanup();
    }
  });

  it('writes tags in one case whatever the remote spelling', () => {
    assert.equal(tagFor({ repo: 'CrossBibleInc/CrossBible', date: '2026-10-14', kind: 'general' }), '[wbi:crossbibleinc/crossbible:2026-10-14]');
    assert.equal(tagFor({ repo: 'Acme/Widgets', date: '2026-10-14', kind: 'pr', pr: 5 }), '[wbi:acme/widgets#5:2026-10-14]');
  });
});

describe('context of a gap', () => {
  const c = config();
  const range = buildRange('2026-10-01', '2026-10-31', c.timezone);
  const point = (time, cwd, branch) => ({ t: Date.parse(at(`2026-10-14 ${time}`)), cwd, branch });
  const prOn = (repo, number, branch) => ({
    repo, number, title: `PR ${number}`, url: null, headRefName: branch, linkedIssue: null,
    createdAt: 0, closedAt: null, updatedAt: 0, commits: [], commitCount: 0,
  });
  const run = (points, prs) => estimate({
    agents: [{ key: 'a', sessionId: 'a', agentId: 'main', prompts: [], points }],
    prs, resolveRepo: (cwd) => ({ '/r1': 'acme/one', '/r2': 'acme/two' })[cwd], lookupRefs: () => new Map(), config: c, range,
  }).repos.flatMap((r) => r.lines.map((l) => [l.repo, l.pr, l.active_seconds]));

  it('gives a gap to the branch of its earlier message', () => {
    const points = [point('10:00:00', '/r1', 'b1'), point('10:05:00', '/r1', 'b1'), point('10:10:00', '/r1', 'b2'), point('10:20:00', '/r1', 'b2')];
    assert.deepEqual(run(points, [prOn('acme/one', 1, 'b1'), prOn('acme/one', 2, 'b2')]), [['acme/one', 1, 600], ['acme/one', 2, 600]]);
  });

  it('gives a gap to the repo of its earlier message', () => {
    const points = [point('10:00:00', '/r1', 'b1'), point('10:05:00', '/r1', 'b1'), point('10:10:00', '/r2', 'b2'), point('10:20:00', '/r2', 'b2')];
    assert.deepEqual(run(points, [prOn('acme/one', 1, 'b1'), prOn('acme/two', 2, 'b2')]), [['acme/one', 1, 600], ['acme/two', 2, 600]]);
  });
});
