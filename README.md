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
  service, shows the review table, lets you mark PRs, issues and branch days
  as flat-rate, and runs `push.sh` only after you approve that table.

Both skills run the scripts below from the installed plugin. The scripts do
every calculation and every FreshBooks call.

## Configuration

The setup skill, or `bin/init-config.sh`, copies `assets/config.example.json`
to `~/.config/workbench-freshbooks-timetracking/config.json` when no config
exists there. Set `WBFT_CONFIG` to use another path. The file holds no secrets.
`plan.sh` and `push.sh` keep `ledger.json` in the same folder. It maps the
internal key of each line to the ids of its FreshBooks entries, and holds no
secrets either.

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
| `freshbooks.flat_rate_days` | `{}` | Lower-case `owner/name` to the `YYYY-MM-DD` days whose branch line is flat-rate, saved by `flat-rate.sh`. A mark saved for a former general line keeps that entry flat-rate after it is relabelled |

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
  date-range choices: since the latest day of an entry the ledger records (or
  that an older note tags), this month so far, and last month.
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
- `flat-rate.sh` lists the PRs, issues and branch days of a lines file, and
  whether a saved mark makes each one flat-rate. `--mark` saves a mark for an
  item in the file, and `--clear` removes a saved mark. An item is
  `owner/name#number` for a PR or an issue, and `owner/name:YYYY-MM-DD` for
  the branch line of one repo on one day. A PR mark covers every line of its
  PR, and an issue mark every issue line of its issue. A mark holds in every
  later run, until it is cleared.
- `plan.sh` turns each line into an entry: `is_logged` true, a duration of the
  billable hours in seconds, a `started_at` at the line's first work on its
  local day, the mapped client and project, and the label as the note. A note
  never holds an internal key. Every entry is billable. An hourly line goes under the repo's
  `service_id`, and a flat-rate line under its `flat_rate_service_id`, so a
  $0 flat-rate service shows the line on the invoice at $0.
- `plan.sh` finds the entries of each line in this order:
  1. The ids the ledger records for the line's key.
  2. An entry whose note still carries the line's key as an older
     `[wbi:<key>]` tag, in any case.
  3. When the ledger has no record for the key: an entry on the same local
     day, in the same project, whose note equals the line's note. The compare
     ignores emoji and runs of spaces, because FreshBooks strips some emoji.
     It never takes an entry that the ledger records for another key, or that
     carries a tag.
  4. For a line that took over the time of a former general line, the entry
     of that general line, by its ledger record or its tag.
- A line with no entry is created. A line that shares the time of a former
  general line with a larger line, and has no entry of its own, is skipped
  when that entry already bills it. It is also skipped, and named in the
  table, when the ledger does not know that entry but an unrecorded entry on
  the same day and project carries the larger line's note, because that
  entry may bill it.
- An entry matched by its note alone is skipped and shown as "matched by note
  only". The plan never changes its billable flag or service on that guess.
- The ledger records the matches by ledger or tag while the plan has no
  "Cannot" line, and each new entry as soon as FreshBooks returns its id. A
  match by note alone is a guess, and never reaches the ledger, before or
  after a push.
- For each matched entry the plan compares the billable flag, the service and
  the note with what it would create. A note changes only when it carries an
  older tag: it becomes the line's label, which drops the tag and relabels a
  former general entry with the PR or issue its time belongs to. A note
  without a tag stays as it is, so an edit made in FreshBooks survives. An
  entry matched through a former general line keeps the rate of its day:
  flat-rate when the day carries a flat-rate mark, hourly otherwise, whatever
  the rate of the line that took over its time. A tagged entry in the range and repos of the
  lines that no line matches loses its tag, and keeps everything else.
  When that tag is a general one, no line can relabel the entry. It then
  takes the note of a tagged PR or issue entry in the same repo, project and
  day, without its tag. The longest such entry gives the note, and on equal
  durations the one with the lowest id.
  An update never touches the duration or the date, and never an entry that
  is neither in the ledger nor tagged. The plan prints
  one approval code that covers each new entry and each update, so a changed
  mark or a changed FreshBooks entry needs a new review.
- The plan has no code, and says why, in any of these cases:
  - A repo has flat-rate lines, new or already in FreshBooks, but no
    flat-rate service.
  - The FreshBooks list leaves out `billable`, `service_id`, `duration` or
    `started_at` for a matched entry, so the plan cannot compare it.
  - The FreshBooks list leaves out `is_logged`, `client_id` or `project_id`
    for an entry to update, so the plan cannot send the full entry.
  - The listed `is_logged` of an entry to update is not true or false, or its
    `started_at` or `duration` is not a valid value.
  - An update has no valid entry id.
  - One entry matches more than one line.
  - The ledger records an entry that FreshBooks does not list for that window.
  - An entry still carries the tag of a general line that no line of the
    estimate can relabel, and no tagged PR or issue entry of that repo,
    project and day can give it a note.
  - A tagged entry that no line matches has a note that is empty, or still
    holds an internal key, once its tag is dropped.
- The plan table groups the new entries by repo in order of first work, shows
  the rate of each line, marks git-sourced lines, and splits hourly from
  flat-rate hours. A separate section lists the updates with the client and
  project of each entry, and how the plan matched it (ledger, older tag, or relabelled from a same-day entry), and a list names the unchanged entries.
- `push.sh` builds the plan again, and creates and updates entries only when
  the code matches, so a changed line set, a changed mark or a changed
  FreshBooks entry needs a new review. It changes nothing while the plan has
  no code. It creates the new entries first, then sends each update as a PUT
  of the full entry as the list returned it (`is_logged`, `started_at`,
  `duration`, `note`, `client_id`, `project_id`, `service_id` and
  `billable`), with only the billable flag, the service or the note changed.
  It refuses an update of an entry the plan did not match, and any note that
  holds an internal key. FreshBooks
  refuses a PUT that leaves out `started_at` or `is_logged`, and a field left
  out could be reset. The approval code covers every value of that body. It
  stops when the PUT response does not show the new values, or shows any
  other field of the body with a value other than the one it sent.
  It stops at the first error, and prints which entries were created, which
  were updated, which were skipped, which failed and which were not attempted.
  A failed update says whether the entry may have changed. It also stops when
  the ledger cannot record a new entry, and reports that entry as created.

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
4. Time that is still unmatched goes to the PR that holds a commit by one of
   the `authors`, made during that run of work or within one idle gap after
   it. `estimate.sh` searches GitHub for the PRs of that repo updated in the
   range, with their commit authors, and warns when it read only the first
   100 commits of a PR. When several PRs hold such commits, the time splits by
   their number of commits.
5. Failing that, it goes to the PR with the most time in that repo on that
   day, then to the PR of the nearest day in the range.
6. Only a repo with no PR in the range keeps its own line per day, labelled
   with its branches, such as "Work on branch main".
7. A billable PR with no session time from steps 2 to 4 gets git-sourced
   lines from its commit times: the same gap rule, plus one idle gap of
   lead-in before each burst.

Each line carries an internal key: `owner/repo#<PR or issue>:<date>`, or
`owner/repo:<date>` for a branch line. The repo in a key is always lower case,
so the key does not depend on how a remote spells it. The key stays out of
FreshBooks: the ledger maps it to entry ids. A line that took over time from
steps 4 and 5 carries `former`: `primary` for the line with the largest share
of that repo's day, which inherits the entry of the former general line, and
`shared` for the others.

## Development

```bash
scripts/test.sh
scripts/lint.sh
```
