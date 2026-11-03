---
name: estimate
description: Turn a date range of AI development work into FreshBooks time entries. Asks for the range and the repos, maps unmapped repos to a FreshBooks client, project and service, shows the review table, and creates the entries only after Mike approves that exact table.
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
  one item, and how to split a longer list.
- No step needs the client secret or a token. Never ask for one, show one or
  pass one.
- Pass a value Mike typed to a script in single quotes. A date must look like
  `YYYY-MM-DD`, a repo like `owner/name`, and an id must be digits only. If a
  typed value does not fit, say so and ask again.
- When a script fails, show its error message in one sentence and ask how to go
  on. Never retry without his pick.
- Write to Mike in short, full sentences. Lead with the answer.

## The approval rule

`push.sh` creates FreshBooks entries. Run it only under all of these
conditions:

1. You showed Mike the review table from `plan.sh` in this run.
2. Right after that table, Mike picked "Create these entries" in an
   AskUserQuestion.
3. You pass the approval code printed in that same table, and the same lines
   file that `plan.sh` read.

Never pick for Mike, never take approval from prose or from an earlier run,
and never reuse a code. If anything changes after his pick, such as the range,
the repos, a mapping or the lines file, that pick no longer counts. Run
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

It prints `mapped` and `unmapped`. If `unmapped` is empty, go to step 5.

Otherwise run `bash "${CLAUDE_PLUGIN_ROOT}/bin/choices.sh"` once. It prints
`clients`, `projects` and `services`, each with `id`, `label` and
`description`. Each project also carries its `client_id` and its
`service_ids`.

Map the unmapped repos one at a time. For each repo:

1. If you mapped a repo earlier in this run, first ask "Map `<repo>` the same
   way as `<earlier repo>`?" The options are the earlier client, project and
   service by label, and "Choose another client, project and service".
2. Ask for the client. Then ask for the project, offering only the projects
   whose `client_id` is that client or empty. Then ask for the service,
   offering the project's `service_ids` when it has any, and every service
   when it has none. If the client has no project, tell Mike and ask him to
   pick another client or to stop.
3. Each of these is a single pick, with `multiSelect` false:
   - When the list holds one item, ask "Use `<item>`?" with the options "Yes"
     and "Choose another client". For the client itself, the second option is
     "Stop".
   - When the list holds 2 to 4 items, offer them all in one question.
   - When the list holds more than 4 items, page it, one question per call.
     Each page holds 3 items and a fourth option "Show the next 3". The last
     page holds the 1 to 3 items left and the option "Back to the first page".
   - Other takes an id typed from the list.
4. Save the mapping:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/bin/map.sh" --repo '<owner/name>' --client '<id>' --project '<id>' --service '<id>'
   ```

   `map.sh` checks the ids against FreshBooks. If it refuses them, show the
   reason and ask again for that repo.

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

The plan table has one section per repo, in order of first work, with a total
per repo. Its Source column marks each line that comes from git commit times
as "git (fallback)". A "To create" line gives the number of entries and their
hours. A list shows the lines that FreshBooks already holds, which the push
skips. The last line is the approval code.

Copy the whole table into your reply, unchanged. If it says "Nothing new to
create.", tell Mike that every line is already in FreshBooks, and stop.

## Step 6: Ask for approval

Right after the table, ask: "Create these entries in FreshBooks?" Use the
numbers from the "To create" line in the question. The options are:

- "Create these entries": the description says it creates exactly the entries
  in the table above, under approval code `<code>`.
- "Change the selection": go back to step 3 with the same range. The current
  code no longer counts.
- "Stop": create nothing.

Only on "Create these entries", run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/push.sh" --lines '<lines file>' --approve '<code from the table>'
```

`push.sh` builds the plan again and creates nothing when the code does not
match. If it exits with "the approval code does not match", FreshBooks or the
lines changed since the table. Do not pass any other code. Run `plan.sh` again,
show the new table and ask again in this step.

## Step 7: Report the result

`push.sh` prints JSON with `created`, `skipped`, `failed` and `not_attempted`.
It prints the same JSON when it stops at an error.

Lead with the outcome in one sentence: how many entries were created, and
whether the push finished. Then:

- Name the skipped lines when there are any.
- When `failed` is set, name its tag and error. Its `created` field says
  whether that entry exists:
  - `no`: FreshBooks refused it, and a rerun of this skill tries it again.
  - `unknown`: Mike checks FreshBooks for that entry before a rerun.
  - `yes`: the entry exists but its note lost the tag. Mike fixes the note in
    FreshBooks before a rerun, or the rerun creates it twice.
- List the `not_attempted` tags, and say that a rerun of this skill picks them
  up, because the push skips every entry that already exists.
