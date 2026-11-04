# workbench-freshbooks-timetracking

A Claude Code plugin that turns AI development work in GitHub repos into
reproducible time lines for FreshBooks. It reads Claude Code transcripts and
GitHub, prints line items for review, and creates FreshBooks time entries only
for a set of lines that was approved.

## Requirements

- `node` 20 or later, `git`, and `gh` signed in to GitHub
- macOS, for the keychain, and `openssl` for the login listener
- `shellcheck`, `jq` and `ruby` for `scripts/lint.sh`

## Skills

- `/workbench-freshbooks-timetracking:setup` creates the config, offers the
  hour settings, walks through registering the FreshBooks app, saves the client
  secret to the keychain through a hidden macOS dialog, and logs in. A rerun
  keeps the config and the repo mappings, and redoes only the steps you pick.
- `/workbench-freshbooks-timetracking:estimate` asks for a date range and the
  repos, maps each unmapped repo to an hourly and an optional flat-rate
  service, shows the review table, lets you mark PRs, issues and general days
  as flat-rate, and runs `push.sh` only after you approve that table.

Both skills run the scripts below from the installed plugin. The scripts do
every calculation and every FreshBooks call.

## Configuration

The setup skill, or `bin/init-config.sh`, copies `assets/config.example.json`
to `~/.config/workbench-freshbooks-timetracking/config.json` when no config
exists there. Set `WBFT_CONFIG` to use another path. The file holds no secrets.

| Key | Default | Meaning |
|---|---|---|
| `human_minutes_per_ai_hour` | 20 | Billable minutes per hour of active agent time |
| `idle_gap_minutes` | 15 | A gap between two messages above this is idle and not counted |
| `rounding_step_hours` | 0.25 | Each line rounds up to a multiple of this |
| `timezone` | system zone | IANA zone that decides the work day |
| `authors` | required | GitHub logins whose PRs are billable; Apps as `slug[bot]` |
| `freshbooks.client_id` | none | Client id of the FreshBooks app |
| `freshbooks.redirect_uri` | `https://localhost:8443` | Redirect URI registered on the app; HTTPS, no query string |
| `freshbooks.business_id`, `freshbooks.account_id` | set by login | Business the entries go to; set `business_id` with `configure.sh` first if the login has several |
| `freshbooks.repos` | `{}` | Lower-case `owner/name` to `{client_id, project_id, service_id}`, plus an optional `flat_rate_service_id`, saved by `map.sh`; `service_id` is the hourly service |
| `freshbooks.flat_rate_prs` | `{}` | Lower-case `owner/name` to the PR numbers marked flat-rate, saved by `flat-rate.sh` |
| `freshbooks.flat_rate_issues` | `{}` | Lower-case `owner/name` to the issue numbers marked flat-rate, saved by `flat-rate.sh` |
| `freshbooks.flat_rate_days` | `{}` | Lower-case `owner/name` to the `YYYY-MM-DD` days whose general line is flat-rate, saved by `flat-rate.sh` |

The client secret and the tokens live only in the macOS keychain, under the
service `workbench-freshbooks-timetracking`. No script prints them, and none
passes them as a command argument.

## Commands

```bash
bin/repos.sh --from 2026-10-01 --to 2026-10-31
bin/estimate.sh --from 2026-10-01 --to 2026-10-31 --repo owner/name [--repo ...] [--format table]
```

`repos.sh` prints JSON: the repos with in-range activity, most active first,
as `label` and `description` options, plus an `orgs` grouping. `estimate.sh`
prints the line items as JSON, or the review table with `--format table`.
Both accept `--config` and `--projects-dir`.

## FreshBooks

```bash
bin/init-config.sh
bin/configure.sh [--human-minutes-per-ai-hour n] [--idle-gap-minutes n] [--rounding-step-hours n]
                 [--timezone zone|system] [--client-id id] [--redirect-uri url] [--business-id id]
bin/status.sh
bin/store-secret.sh [--dialog]         # hidden macOS dialog, hidden terminal prompt, or stdin
bin/login.sh [--no-open]
bin/range.sh
bin/choices.sh
bin/map.sh --repo owner/name --client <id> --project <id> --service <id> [--flat-rate-service <id>]
bin/unmapped.sh --repo owner/name [--repo ...]
bin/estimate.sh --from ... --to ... --repo owner/name > lines.json
bin/flat-rate.sh --lines lines.json [--mark owner/name#number|owner/name:YYYY-MM-DD ...] [--clear ...]
bin/plan.sh --lines lines.json [--format table]
bin/push.sh --lines lines.json --approve <code>
```

- `configure.sh` validates each value before it saves it. A redirect URI must
  use https on `localhost` or `127.0.0.1`. `--timezone system` follows the
  machine zone.
- `status.sh` prints the settings, the FreshBooks ids, the mapped repos, and
  whether a client secret and a login are in the keychain, as true or false.
  `timezone_follows_system` is true when the config names no zone, and false
  when it pins one, even a zone equal to the system zone.
- `scripts/check-skills.sh` checks each skill: closed frontmatter, a name
  equal to its folder, a description, and scripts reached through
  `${CLAUDE_PLUGIN_ROOT}/bin/`. `scripts/lint.sh` runs it.
- `store-secret.sh --dialog` takes the secret from a macOS dialog with a hidden
  field and pipes it to the keychain. A cancelled dialog saves nothing.
- `range.sh` reads the FreshBooks entries of the last 366 days and prints
  date-range choices: since the latest day a tag names, this month so far, and
  last month.
- The app needs the scopes `user:profile:read`, `user:projects:read`,
  `user:clients:read`, `user:billable_items:read`, `user:time_entries:read` and
  `user:time_entries:write`.
- `login.sh` listens on the redirect URI with a throwaway self-signed
  certificate, opens the approval page, and catches the code. The browser warns
  once about the certificate. A callback whose `state` does not match is
  rejected. The listener gives up after 5 minutes. The redirect host must be
  `localhost` or `127.0.0.1`. If another process already answers on the
  redirect port, the login fails at once and names the port. The URI set on
  the FreshBooks app must match the saved one exactly, path included.
- A refresh token works once. Each refresh saves the new refresh token to the
  keychain before anything else, and a 401 triggers one refresh and one retry.
  A 429 backs off, honoring `Retry-After`.
- `choices.sh` prints the active clients, the projects and the active services
  as `id`, `label` and `description` options. `map.sh` checks the ids against
  FreshBooks before it saves them, and refuses a flat-rate service equal to
  the hourly one.
- `flat-rate.sh` lists the PRs, issues and general days of a lines file, and
  whether a saved mark makes each one flat-rate. `--mark` saves a mark for an
  item in the file, and `--clear` removes a saved mark. An item is
  `owner/name#number` for a PR or an issue, and `owner/name:YYYY-MM-DD` for
  the general line of one repo on one day. A PR mark covers every line of its
  PR, and an issue mark every issue line of its issue. A mark holds in every
  later run, until it is cleared.
- `plan.sh` turns each line into an entry: `is_logged` true, a duration of the
  billable hours in seconds, a `started_at` at the line's first work on its
  local day, the mapped client and project, and the label followed by the tag
  as the note. Every entry is billable. An hourly line goes under the repo's
  `service_id`, and a flat-rate line under its `flat_rate_service_id`, so a
  $0 flat-rate service shows the line on the invoice at $0.
- `plan.sh` compares each entry whose note carries a line's tag, in any case,
  with what it would create for that line. When the billable flag or the
  service differs, it lists the entry to update, with the old and new values.
  An update never touches the duration, the date or the note, and never an
  entry without a tag. Every other tagged entry is skipped. The plan prints
  one approval code that covers each new entry and each update, so a changed
  mark or a changed FreshBooks entry needs a new review.
- The plan has no code, and says why, in any of these cases:
  - A repo has flat-rate lines, new or already in FreshBooks, but no
    flat-rate service.
  - The FreshBooks list leaves out `billable`, `service_id`, `duration` or
    `started_at` for a tagged entry, so the plan cannot compare it.
  - An update has no valid entry id.
  - One entry carries the tags of more than one line.
- The plan table groups the new entries by repo in order of first work, shows
  the rate of each line, marks git-sourced lines, and splits hourly from
  flat-rate hours. A separate section lists the updates, and a list names the
  unchanged entries.
- `push.sh` builds the plan again, and creates and updates entries only when
  the code matches, so a changed line set, a changed mark or a changed
  FreshBooks entry needs a new review. It changes nothing while the plan has
  no code. It creates the new entries first, then sends each update as a PUT
  with only the changed keys. It stops when the PUT response does not show the
  new values, or shows a duration, date or note other than the listed one.
  It stops at the first error, and prints which entries were created, which
  were updated, which were skipped, which failed and which were not attempted.
  A failed update says whether the entry may have changed. It also stops when
  FreshBooks stores a note without its tag, because a rerun could not detect
  that entry.

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
