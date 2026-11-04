import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { run } from '../lib/cli.mjs';
import { config, fakeGh, gitRepo, issue, pr, sandbox, transcript } from './lib/fixtures.mjs';

const SCRATCH_SESSION = '11111111-2222-3333-4444-555555555555';

describe('estimate over a fixture month', () => {
  let box;
  let gh;
  let base;

  before(() => {
    box = sandbox();
    const widgets = gitRepo(join(box.root, 'code', 'widgets'), 'git@github.com:acme/widgets.git');
    const projects = join(box.root, 'projects');
    const p = (...parts) => join(projects, ...parts);

    const mainA = transcript(p('-code-widgets', 's1.jsonl'), {
      sessionId: 's1', cwd: widgets, branch: 'feat/login',
      times: ['2026-10-14 10:00:00', '2026-10-14 10:10:00', '2026-10-14 10:24:59', '2026-10-14 10:40:00', '2026-10-14 10:50:00', '2026-10-14 11:05:00'],
    });
    writeFileSync(p('-code-widgets', 's1-resumed.jsonl'), `${mainA.join('\n')}\n`);
    transcript(p('-code-widgets', 's1', 'subagents', 'agent-b.jsonl'), {
      sessionId: 's1', agentId: 'b', cwd: widgets, branch: 'feat/login',
      times: ['2026-10-14 10:00:00', '2026-10-14 10:10:00', '2026-10-14 23:52:00', '2026-10-15 00:02:00', '2026-10-15 00:12:00'],
    });
    transcript(p('-code-widgets', 's2.jsonl'), {
      sessionId: 's2', cwd: widgets, branch: 'main', prompt: 'Please fix #999 and then #9',
      times: ['2026-10-31 23:55:00', '2026-11-01 00:05:00'],
    });
    transcript(p('-code-widgets', 's3.jsonl'), {
      sessionId: 's3', cwd: widgets, branch: 'main', prompt: 'Work on #7',
      times: ['2026-10-16 10:00:00', '2026-10-16 10:05:00'],
    });
    transcript(p('-code-widgets', 's7.jsonl'), {
      sessionId: 's7', cwd: widgets, branch: 'main', prompt: 'Look at [Image #9] and fix #4',
      times: ['2026-10-20 10:00:00', '2026-10-20 10:06:00'],
    });
    transcript(p('-code-widgets', 's9.jsonl'), {
      sessionId: 's9', cwd: widgets, branch: 'late', times: ['2026-10-31 18:00:00', '2026-10-31 18:10:00'],
    });
    transcript(p('-code-widgets', 's8.jsonl'), { sessionId: 's8', cwd: widgets, branch: 'main', prompt: 'Handle #9', times: ['2026-10-21 09:00:00'] });
    transcript(p('-code-widgets', 's8', 'subagents', 'agent-c.jsonl'), {
      sessionId: 's8', agentId: 'c', cwd: widgets, branch: 'main', prompt: 'Go',
      times: ['2026-10-21 10:00:00', '2026-10-21 10:04:00'],
    });
    transcript(p('-code-widgets', `${SCRATCH_SESSION}.jsonl`), { sessionId: SCRATCH_SESSION, cwd: widgets, times: ['2026-10-17 08:00:00'] });
    transcript(p('-scratch', 's4.jsonl'), {
      sessionId: 's4', cwd: `/private/tmp/claude-503/-code-widgets/${SCRATCH_SESSION}/scratchpad`,
      times: ['2026-10-17 09:00:00', '2026-10-17 09:12:00'],
    });
    transcript(p('-gone', 's5.jsonl'), {
      sessionId: 's5', cwd: join(box.root, 'gone', 'worktrees', 'gadgets', 'feature-x'), branch: 'feature-x',
      times: ['2026-10-02 08:00:00', '2026-10-02 08:05:00'],
    });
    transcript(p('-gone', 's6.jsonl'), {
      sessionId: 's6', cwd: join(box.root, 'gone', 'elsewhere'),
      times: ['2026-10-03 08:00:00', '2026-10-03 08:10:00'],
    });

    const configPath = join(box.root, 'config.json');
    writeFileSync(configPath, JSON.stringify(config()));
    gh = fakeGh({
      prs: [
        pr({ number: 12, title: 'Add login', headRefName: 'feat/login', createdAt: '2026-10-13T00:00:00Z', linkedIssue: { number: 7, title: 'Login page' }, commits: ['2026-10-14 11:00:00'] }),
        pr({ number: 30, title: 'Late', headRefName: 'late', createdAt: '2026-11-01T01:00:00Z', updatedAt: '2026-11-01T02:00:00Z', commits: ['2026-10-31 18:05:00'] }),
        pr({ number: 20, title: 'Fix typo', headRefName: 'fix/typo', commits: ['2026-09-30 12:00:00', '2026-10-16 09:00:00', '2026-10-16 09:10:00', '2026-10-16 13:00:00'] }),
        pr({ repo: 'acme/gadgets', number: 3, title: 'Feature X', headRefName: 'feature-x', linkedIssue: { number: 9, title: 'Upstream', repository: { nameWithOwner: 'acme/widgets' } } }),
      ],
      refs: { 'acme/widgets': { 4: issue(4, 'Old issue', '2026-09-01T00:00:00Z'), 7: issue(7, 'Login page'), 9: issue(9, 'Fix footer') } },
    });
    base = ['--config', configPath, '--projects-dir', projects];
  });

  after(() => box.cleanup());

  const estimate = async (from, to, ...extra) => JSON.parse(await run(['estimate', '--from', from, '--to', to, ...base, ...extra], { gh }));
  const summary = (line) => [line.date, line.kind, line.pr ?? line.issue, line.source, line.active_seconds, line.billable_hours, line.key, line.former];

  it('builds one line per PR per work day with pinned hours, labels, sources and keys', async () => {
    const result = await estimate('2026-10-01', '2026-10-31');
    const widgets = result.repos.find((r) => r.repo === 'acme/widgets');
    assert.deepEqual(widgets.lines.map(summary), [
      ['2026-10-14', 'pr', 12, 'session', 4079, 0.5, 'acme/widgets#12:2026-10-14', null],
      ['2026-10-15', 'pr', 12, 'session', 720, 0.25, 'acme/widgets#12:2026-10-15', null],
      ['2026-10-16', 'pr', 20, 'git', 2400, 0.25, 'acme/widgets#20:2026-10-16', null],
      ['2026-10-16', 'pr', 12, 'session', 300, 0.25, 'acme/widgets#12:2026-10-16', null],
      ['2026-10-17', 'pr', 20, 'session', 720, 0.25, 'acme/widgets#20:2026-10-17', 'primary'],
      ['2026-10-20', 'pr', 20, 'session', 360, 0.25, 'acme/widgets#20:2026-10-20', 'primary'],
      ['2026-10-21', 'issue', 9, 'session', 240, 0.25, 'acme/widgets#9:2026-10-21', null],
      ['2026-10-31', 'pr', 30, 'session', 600, 0.25, 'acme/widgets#30:2026-10-31', null],
      ['2026-10-31', 'issue', 9, 'session', 300, 0.25, 'acme/widgets#9:2026-10-31', null],
    ]);
    assert.equal(widgets.lines[0].label, 'Issue #7: Login page (PR #12)');
    assert.equal(widgets.lines[0].ai_hours, 1.13);
    assert.equal(widgets.lines[2].label, 'PR #20: Fix typo');
    assert.equal(widgets.lines[4].label, 'PR #20: Fix typo');
    assert.ok(result.repos.every((r) => r.lines.every((l) => !l.label.includes('General development') && !('tag' in l))));
    assert.equal(widgets.lines[8].label, 'Issue #9: Fix footer');
  });

  it('orders repos and lines by first work in the range', async () => {
    const result = await estimate('2026-10-01', '2026-10-31');
    assert.deepEqual(result.repos.map((r) => r.repo), ['acme/gadgets', 'acme/widgets']);
    assert.deepEqual(result.repos[0].lines.map(summary), [['2026-10-02', 'pr', 3, 'session', 300, 0.25, 'acme/gadgets#3:2026-10-02', null]]);
    assert.equal(result.repos[0].lines[0].label, 'Issue acme/widgets#9: Upstream (PR #3)');
    assert.equal(result.repos[0].lines[0].issue_repo, 'acme/widgets');
  });

  it('reports time whose cwd resolves to no repo', async () => {
    const result = await estimate('2026-10-01', '2026-10-31');
    assert.equal(result.unattributed.ai_hours, 0.17);
    assert.equal(result.unattributed.top_cwds[0].cwd, join(box.root, 'gone', 'elsewhere'));
  });

  it('counts only in-range work for a single past day', async () => {
    const result = await estimate('2026-10-15', '2026-10-15');
    assert.deepEqual(result.repos.flatMap((r) => r.lines.map(summary)), [
      ['2026-10-15', 'pr', 12, 'session', 720, 0.25, 'acme/widgets#12:2026-10-15', null],
    ]);
  });

  it('keeps only the chosen repos', async () => {
    const result = await estimate('2026-10-01', '2026-10-31', '--repo', 'acme/gadgets');
    assert.deepEqual(result.repos.map((r) => r.repo), ['acme/gadgets']);
  });

  it('marks git-sourced lines in the review table', async () => {
    const table = await run(['estimate', '--from', '2026-10-01', '--to', '2026-10-31', '--format', 'table', ...base], { gh });
    assert.match(table, /\| 2026-10-16 \| PR #20: Fix typo \| 0\.67 \| 0\.25 \| git \(fallback\) \| `acme\/widgets#20:2026-10-16` \|/);
    assert.match(table, /\| 2026-10-16 \| Issue #7: Login page \(PR #12\) \| 0\.08 \| 0\.25 \| session \|/);
  });

  it('lists repos with in-range activity, most active first, grouped by org', async () => {
    const choices = JSON.parse(await run(['repos', '--from', '2026-10-01', '--to', '2026-10-31', ...base], { gh }));
    assert.deepEqual(choices.repos.map((r) => [r.label, r.ai_hours]), [['acme/widgets', 2.7], ['acme/gadgets', 0.08]]);
    assert.match(choices.repos[0].description, /first work 2026-10-14$/);
    assert.deepEqual(choices.orgs, [{ org: 'acme', ai_hours: 2.78, repos: ['acme/widgets', 'acme/gadgets'] }]);
  });

  it('lists no repo for a range without activity', async () => {
    const choices = JSON.parse(await run(['repos', '--from', '2026-09-01', '--to', '2026-09-29', ...base], { gh }));
    assert.deepEqual(choices.repos, []);
  });

  it('asks GitHub for PRs by the configured authors in the range', async () => {
    gh.calls.length = 0;
    await estimate('2026-10-01', '2026-10-31');
    assert.equal(gh.calls[0].variables.q, 'is:pr author:mikebronner updated:>=2026-09-30 created:<=2026-11-01');
    assert.deepEqual(gh.calls.filter((c) => /repo:/.test(c.variables.q ?? '')).map((c) => c.variables.q), ['is:pr repo:acme/widgets updated:>=2026-09-30 created:<=2026-11-01']);
  });
});
