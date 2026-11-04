---
name: estimate
description: Turn a date range of AI development work into FreshBooks time entries. Asks for the range and the repos, maps unmapped repos to a FreshBooks client, project, hourly service and optional flat-rate service, shows the review table, lets Mike mark PRs, issues and branch days as flat-rate, and creates new entries and corrects existing ones, including relabelling older tagged notes, only after Mike approves that exact table.
---

# Estimate and push FreshBooks time entries

This skill takes Mike from a date range to approved FreshBooks time entries.
The scripts compute every number and make every FreshBooks call. This skill
only asks, shows and confirms.

## Rules for every step

- Run each script as `bash "${CLAUDE_PLUGIN_ROOT}/bin/<script>.sh"`. Never run a
  script from a checkout of the repository.
- Every date, hour, total and table comes from a script. Never compute, round,
  add up, sort or regroup hours yourself. Show a table exactly as the script
  printed it.
- Put every decision to Mike through AskUserQuestion. Never ask in prose.
- Give every question 2 to 4 options. Steps 3 and 4 say how to ask a list of
  one item, and how to split a longer list. Step 7 uses the same rules for
  flat-rate marks.
- No step needs the client secret or a token. Never ask for one, show one or
  pass one.
- Pass a value Mike typed to a script in single quotes. A date must look like
  `YYYY-MM-DD`, a repo like `owner/name`, and an id must be digits only. If a
  typed value does not fit, say so and ask again.
- When a script fails, show its error message in one sentence and ask how to go
  on. Never retry without his pick.
- Write to Mike in short, full sentences. Lead with the answer.

## The approval rule

`push.sh` creates FreshBooks entries and updates existing ones. Run it only
under all of these conditions:

1. You showed Mike the review table from `plan.sh` in this run.
2. Right after that table, Mike picked "Apply these changes" in an
   AskUserQuestion.
3. You pass the approval code printed in that same table, and the same lines
   file that `plan.sh` read.

Never pick for Mike, never take approval from prose or from an earlier run,
and never reuse a code. If anything changes after his pick, such as the range,
the repos, a mapping, a flat-rate mark or the lines file, that pick no longer
counts. Run
`plan.sh` again, show the new table and ask again.

## Step 1: Check the setup

Run `bash "${CLAUDE_PLUGIN_ROOT}/bin/status.sh"`. If `config_exists` or
`logged_in` is false, or `freshbooks.business_id` is not set, tell Mike to run
`/workbench-freshbooks-timetracking:setup` first, and stop.

## Step 2: Choose the date range

Run `bash "${CLAUDE_PLUGIN_ROOT}/bin/range.sh"`. It prints `today`,
`last_billed` and a list of `choices`. Each choice has a `label`, a
`description`, a `from` and a `to`. "Since last billed" starts on the latest
day that already has an entry from this plugin in FreshBooks. It is missing
when no such entry exists.

Ask: "Which dates do you want to bill?" Use the choices as options, in the
printed order, with their label and description. Tell Mike in the question that
Other takes any past range, typed as `YYYY-MM-DD to YYYY-MM-DD`.

If `range.sh` fails, show its error and ask Mike to type the range through
Other, with the options "Try again" and "Stop".

## Step 3: Choose the repos

Run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/repos.sh" --from '<from>' --to '<to>'
```

It prints JSON with these fields:

- `repos`: only the repos with activity in the range, most active first. Each
  has `repo`, `org`, `label` and `description`.
- `orgs`: each org with its `ai_hours` and its list of `repos`.
- `unattributed` and `warnings`.

If `repos` is empty, tell Mike that the range has no billable activity, and
stop. Mention each warning, and the unattributed AI hours when they are above
zero, in one sentence each.

Offer only repos from this list. AskUserQuestion takes 2 to 4 options per
question and at most 4 questions per call. Every list on every path below, of
orgs or of repos, goes through one of these two forms:

- **A list of one item:** never put it in a batch. Ask "Include `<item>`?"
  with the options "Yes" and "No".
- **A list of 2 or more items:** ask it in batches.
  - Keep the printed order.
  - Put 2 to 4 items in one question and at most 4 questions in one call.
  - When the last batch would hold one item, move the last item of the batch
    before it into the last batch. Then the last two batches hold 3 and 2.
  - Set `multiSelect` to true.
  - Head each question with its place in the list, such as "Repos 1 to 4 of
    87".
  - Tell Mike in each question that he may pick any number, and that Other
    with "none" skips the batch. Other may also name a repo as `owner/name`.
    Keep a typed name only when it is in `repos`, and tell Mike which typed
    names you dropped.

Choose the flow by the number of repos:

- **One repo:** ask "Bill `<repo>` for this range?" with the options "Yes" and
  "Stop".
- **2 to 16 repos:** ask the list of repos in one call.
- **More than 16 repos:** ask "How do you want to pick from `<n>` repos?" with
  these options:
  - "By org": offer it only when `orgs` holds 2 or more orgs. The description
    names the number of orgs.
  - "All `<n>` repos".
  - "Repo by repo": the description names the number of batches.

  For "By org", ask the list of orgs, with the org as label and its number of
  repos and AI hours as description. Then look at the repos of the picked
  orgs:
  - If they hold one repo, ask the one-item question for it.
  - If they hold 2 or more, ask "Bill every repo of the picked orgs?" with the
    options "All `<m>` repos of these orgs" and "Choose among them". For
    "Choose among them", ask that list of repos.

  For "Repo by repo", ask the whole list of repos, 16 per call, until it ends.

Confirm the selection in one sentence: the number of repos, and their names
when there are 10 or fewer. If the selection is empty, stop.

## Step 4: Map each unmapped repo

Run `unmapped.sh` with every picked repo:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/unmapped.sh" --repo '<owner/name>' --repo '<owner/name>'
```

It prints `mapped` and `unmapped`. Each mapped repo carries its `client_id`,
`project_id`, `service_id` (the hourly service) and, when it has one, its
`flat_rate_service_id`. If `unmapped` is empty, go to step 5.

Otherwise run `bash "${CLAUDE_PLUGIN_ROOT}/bin/choices.sh"` once. It prints
`clients`, `projects` and `services`, each with `id`, `label` and
`description`. Each project also carries its `client_id` and its
`service_ids`.

Map the unmapped repos one at a time. For each repo:

1. If you mapped a repo earlier in this run, first ask "Map `<repo>` the same
   way as `<earlier repo>`?" The options are the earlier client, project,
   hourly service and flat-rate service by label, and "Choose another client,
   project and services".
2. Ask for the client. Then ask for the project, offering only the projects
   whose `client_id` is that client or empty. Then ask "Which service is for
   hourly work on `<repo>`?", offering the project's `service_ids` when it has
   any, and every service when it has none. If the client has no project, tell
   Mike and ask him to pick another client or to stop.
3. Ask "Does `<repo>` have a flat-rate service?" with the options "Yes" and
   "No". The description of "Yes" says that lines Mike marks as flat-rate are
   logged there as billable entries at that service's rate, so a $0 service
   shows them on the invoice at $0. The description of "No" says that
   every line is billed hourly until a flat-rate service is mapped. On "Yes",
   ask "Which service is for flat-rate work on `<repo>`?", offering the same
   services as for the hourly service, without the hourly one. If none is
   left, tell Mike and go on with "No".
4. Each pick of a client, project or service is a single pick, with
   `multiSelect` false:
   - When the list holds one item, ask "Use `<item>`?" with the options "Yes"
     and "Choose another client". For the client itself, the second option is
     "Stop". For the flat-rate service, it is "No flat-rate service".
   - When the list holds 2 to 4 items, offer them all in one question.
   - When the list holds more than 4 items, page it, one question per call.
     Each page holds 3 items and a fourth option "Show the next 3". The last
     page holds the 1 to 3 items left and the option "Back to the first page".
   - Other takes an id typed from the list.
5. Save the mapping. Add `--flat-rate-service` only when Mike picked one:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/bin/map.sh" --repo '<owner/name>' --client '<id>' --project '<id>' --service '<hourly id>' --flat-rate-service '<flat-rate id>'
   ```

   `map.sh` checks every id against FreshBooks, and refuses a flat-rate service
   that equals the hourly one. If it refuses them, show the reason and ask
   again for that repo.

If Mike stops the mapping, ask whether to drop the unmapped repos from the
selection or to stop. After the last mapping, run `unmapped.sh` again with the
selection, and go on only when `unmapped` is empty.

## Step 5: Estimate and show the review table

Run `mktemp` once, and use the path it printed as the lines file in every
later command. Then run the estimate and the plan:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/estimate.sh" --from '<from>' --to '<to>' --repo '<owner/name>' --repo '<owner/name>' > '<lines file>'
bash "${CLAUDE_PLUGIN_ROOT}/bin/plan.sh" --lines '<lines file>' --format table
```

If the `warnings` list in the lines file is not empty, mention each warning
in one sentence before the table.

The plan table has one section per repo with the entries to create, in order
of first work, with a total per repo. Each line shows:

- Its Note: the label alone. No note holds an internal key.
- Its Rate: "hourly", or "flat-rate (saved mark)" when Mike marked its PR,
  issue or branch day as flat-rate in this run or an earlier one. Every
  entry is billable. A flat-rate line goes under the repo's flat-rate service,
  so its price comes from that service's rate.
- Its Source: "git (fallback)" for a line that comes from git commit times.
- Its Service id, or "none" for a flat-rate line in a repo that has no
  flat-rate service.

A section "Existing entries to update" follows when FreshBooks holds entries
of this plugin whose billable flag, service or note differs from what the plan
would create now. The plan knows these entries from the ledger beside the
config, from an older `[wbi:…]` tag in the note, or from a note equal to the
line's label on the same day and project. A note changes only when it still
carries an older tag: the Note cell then shows the old note, an arrow and the
new label. That drops the tag, and relabels a former "General development"
entry with the PR or issue its time now belongs to. When no line holds work in
that repo on that day, a former "General development" entry takes the note of
the longest tagged PR or issue entry of the same repo, project and day,
without its tag. Its Match cell then reads "relabelled from same-day entry"
and that entry's id. Tell Mike in one sentence that this note is a guess from
FreshBooks, and that its rate stays as stored. Each row also shows the
entry id, how the plan matched it ("ledger" or "older tag"), its client and
project, and, for the billable flag and the service,
the old and new value or "unchanged". An update never changes the duration or
the date, and never deletes an entry. It sends every other field back as
FreshBooks holds it.

A "To create" line gives the number of new entries, their hours, and how those
hours split into hourly and flat-rate hours. A "To update" line gives the
number of existing entries to change, and how many note, billable and service
changes they hold. A list shows the entries that FreshBooks already holds
unchanged, which the push skips. A line "billed in former general entry"
names a share of a former general entry that another line's entry already
bills. A line "may be billed in entry …, which the ledger does not record; not
created" names a share the plan did not create because an unrecorded entry
may bill it. Mention it to Mike in one sentence. An entry "matched by note
only" is skipped, and its rate stays as FreshBooks holds it. The last line is the approval
code. When the plan cannot go ahead, the table instead ends with one "Cannot
create" or "Cannot update" line per problem, and "No approval code until every
"Cannot" line above is fixed."

Copy the whole table into your reply, unchanged. If it says "Nothing to create
or update.", tell Mike that FreshBooks already holds every line as planned,
and stop.

## Step 6: Ask for approval

When the table ends with an approval code, ask right after the table: "Apply
these changes in FreshBooks?" Use the numbers from the "To create" and "To
update" lines in the question. The options are:

- "Apply these changes": the description says it creates and updates exactly
  the entries in the table above, under approval code `<code>`.
- "Change flat-rate marks": go to step 7.
- "Change the selection": go back to step 3 with the same range.
- "Stop": create and update nothing.

When the table has no approval code, ask right after the table: "How do you
want to fix the "Cannot" lines?" Name the repos of the "Cannot" lines in the
question. The options are:

- "Map a flat-rate service": offer it only when a "Cannot create" or "Cannot
  update" line says that a repo has no flat-rate service. Go to step 8.
- "Change flat-rate marks": go to step 7.
- "Change the selection": go back to step 3 with the same range.
- "Stop": create and update nothing.

Every pick but "Apply these changes" voids the current code.

Only on "Apply these changes", run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/push.sh" --lines '<lines file>' --approve '<code from the table>'
```

`push.sh` builds the plan again, and creates and updates nothing when the code
does not match. If it exits with "the approval code does not match", FreshBooks, the
lines or a flat-rate mark changed since the table. Do not pass any other code.
Run `plan.sh` again, show the new table and ask again in this step. Then go to
step 9.

## Step 7: Change flat-rate marks

A mark applies in this run and in every later run, until Mike clears it. A
mark has one of three kinds:

- A PR mark covers every line of that PR.
- An issue mark covers every issue line of that issue.
- A branch-day mark covers the branch line of one repo on one day. A mark
  saved earlier for a former general line keeps that entry flat-rate after it
  is relabelled.

Run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/flat-rate.sh" --lines '<lines file>'
```

It prints `items`, one per PR, issue and branch day in the lines file. Each
item has these fields:

- `ref`: `owner/name#number` for a PR or an issue, and `owner/name:YYYY-MM-DD`
  for a branch day.
- `kind`: `pr`, `issue` or `general` (a branch day).
- `label`, and `flat_rate`, which is true when a saved mark applies.
- `description`.

Ask "Which flat-rate marks do you want to change?" with these options:

- "Mark as flat-rate": offer it only when an item has `flat_rate` false. The
  description names how many items are hourly.
- "Clear flat-rate marks": offer it only when an item has `flat_rate` true.
  The description names how many items are marked.
- "Back to the table": change nothing.

For "Mark as flat-rate", the list is the items with `flat_rate` false. For
"Clear flat-rate marks", it is the items with `flat_rate` true. Ask that list
in the printed order, through the two forms of step 3:

- One item: ask "Mark `<ref>` as flat-rate?" or "Clear the flat-rate mark of
  `<ref>`?" with the options "Yes" and "No".
- Two or more items: ask them in batches, with `multiSelect` true, under the
  batch rules of step 3. Head each question with its place, such as "Items 1
  to 4 of 9". Each option has the `ref` as label, and the `label` and
  `description` from the script as description. Other with "none" skips the
  batch. Other may also name an item by its `ref`. Keep a typed item only
  when it is in the list you asked, and tell Mike which typed items you
  dropped.

Then save all picks in one run, with one `--mark` or `--clear` per picked
item:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/flat-rate.sh" --lines '<lines file>' --mark '<owner/name#number>' --mark '<owner/name:YYYY-MM-DD>'
bash "${CLAUDE_PLUGIN_ROOT}/bin/flat-rate.sh" --lines '<lines file>' --clear '<owner/name#number>'
```

If Mike picked nothing, save nothing. If the script refuses an item, show its
reason. It saves nothing in that case, so ask the list again.

On "Back to the table" and after a save, run `plan.sh` with `--format table`
again, as in step 5. Show the new table and ask again in step 6. The earlier
approval code no longer counts.

## Step 8: Map a flat-rate service

For each repo that a "Cannot" line says has no flat-rate service, run
`unmapped.sh` with that repo. It prints the repo under `mapped`, with its `client_id`, `project_id`
and `service_id`. Run `bash "${CLAUDE_PLUGIN_ROOT}/bin/choices.sh"` once.

Ask "Which service is for flat-rate work on `<repo>`?", with the single-pick
rules of step 4. Offer the services of the mapped project without the hourly
`service_id`, or every service but the hourly one when the project lists no
services. If no service is left, tell Mike, and go back to step 6 with the
same table.

Save the mapping with the repo's own client, project and hourly service, and
the picked flat-rate service:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/map.sh" --repo '<owner/name>' --client '<client_id>' --project '<project_id>' --service '<service_id>' --flat-rate-service '<flat-rate id>'
```

If `map.sh` refuses it, show the reason and ask again for that repo. After the
last repo, run `plan.sh` with `--format table` again, as in step 5. Show the
new table and ask again in step 6.

## Step 9: Report the result

`push.sh` prints JSON with `created`, `updated`, `skipped`, `failed` and
`not_attempted`. It prints the same JSON when it stops at an error. It creates
the new entries first, then updates the existing ones.

Lead with the outcome in one sentence: how many entries were created and
updated, and whether the push finished. Then:

- Name the skipped lines when there are any.
- When `failed` is set, name its key and error. Its `action` is `create` or
  `update`.
- For `create`, its `created` field says whether that entry exists:
  - `no`: FreshBooks refused it, and a rerun of this skill tries it again.
  - `unknown`: Mike checks FreshBooks for that entry before a rerun.
  - `yes`: the entry exists, but the ledger beside the config could not
    record it. Mike makes that file writable before a rerun. A rerun still
    finds the entry by its note, unless the note was edited in FreshBooks.
- For `update`, its `changed` field says whether entry `id` may have changed:
  - `no`: FreshBooks refused the change, and a rerun tries it again.
  - `unknown`: the entry may have changed. A rerun lists it under "Existing
    entries to update" again only if it still differs.
- List the `not_attempted` keys, and say that a rerun of this skill picks them
  up, because the plan skips every entry that FreshBooks already holds as
  planned.
