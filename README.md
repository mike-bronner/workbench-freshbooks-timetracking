# workbench-freshbooks-timetracking

A Claude Code plugin that turns AI development work in GitHub repos into
reproducible time lines for FreshBooks. Phase 1 works offline: it reads
Claude Code transcripts and GitHub, and prints line items for review.
Nothing reaches FreshBooks yet.

## Requirements

- `node` 20 or later, `git`, and `gh` signed in to GitHub
- `shellcheck` and `jq` for `scripts/lint.sh`

## Configuration

Copy `assets/config.example.json` to
`~/.config/workbench-freshbooks-timetracking/config.json`, or set `WBFT_CONFIG`
to another path. The file holds no secrets.

| Key | Default | Meaning |
|---|---|---|
| `human_minutes_per_ai_hour` | 20 | Billable minutes per hour of active agent time |
| `idle_gap_minutes` | 15 | A gap between two messages above this is idle and not counted |
| `rounding_step_hours` | 0.25 | Each line rounds up to a multiple of this |
| `timezone` | system zone | IANA zone that decides the work day |
| `authors` | required | GitHub logins whose PRs are billable; Apps as `slug[bot]` |

## Commands

```bash
bin/repos.sh --from 2026-10-01 --to 2026-10-31
bin/estimate.sh --from 2026-10-01 --to 2026-10-31 --repo owner/name [--repo ...] [--format table]
```

`repos.sh` prints JSON: the repos with in-range activity, most active first,
as `label` and `description` options, plus an `orgs` grouping. `estimate.sh`
prints the line items as JSON, or the review table with `--format table`.
Both accept `--config` and `--projects-dir`.

## How hours are counted

- Each transcript in `~/.claude/projects` is one agent. A sub-agent transcript
  in `<session>/subagents/` counts on its own, so parallel agents add up.
- Active time is the sum of the gaps between consecutive messages of one agent.
  A gap above the idle limit counts as zero.
- Time splits at local midnight, and only days inside the range count.
- Billable hours are active hours times the ratio, rounded up per line.

## How time finds its line

1. The repo comes from the git remote of the message's `cwd`. Only when that
   folder no longer exists, a path segment that names exactly one known repo decides it. A
   session scratchpad resolves to the cwd of the session that owns it. Last, a
   branch that heads a PR in only one repo decides it. Time that resolves to no
   repo is reported as unattributed.
2. A `gitBranch` that is the head of a billable PR puts the time on that PR.
3. Otherwise the first PR or issue the agent's prompts name (or its parent
   session's prompts) is used, if GitHub shows it updated in the range. An
   issue that a PR in the same repo closes goes to that PR.
4. Anything else is one general line per repo per day.
5. A billable PR with no session time gets git-sourced lines from its commit
   times: the same gap rule, plus one idle gap of lead-in before each burst.

Each line carries a tag for later deduplication:
`[wbi:owner/repo#<PR or issue>:<date>]`, or `[wbi:owner/repo:<date>]` for a
general line. The repo in a tag is always lower case, so the tag does not
depend on how a remote spells it.

## Development

```bash
scripts/test.sh
scripts/lint.sh
```
