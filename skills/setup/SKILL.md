---
name: setup
description: Set up workbench-freshbooks-timetracking. Creates the config, offers the hour settings, walks through registering the FreshBooks app, saves the client secret to the macOS keychain through a hidden dialog, and logs in. Safe to rerun, because it keeps what exists and redoes only the steps Mike picks.
---

# Set up FreshBooks time tracking

This skill takes Mike from nothing to a working FreshBooks login. The scripts do
every write and every FreshBooks call. This skill only asks, shows and confirms.

## Rules for every step

- Run each script as `bash "${CLAUDE_PLUGIN_ROOT}/bin/<script>.sh"`. Never run a
  script from a checkout of the repository.
- Put every decision to Mike through AskUserQuestion, with the recommended
  option first. Never ask in prose.
- Give every question at least 2 options. When a list to pick from holds one
  item, ask "Use `<item>`?" or "Redo `<item>`?" with the options "Yes" and
  "No" instead.
- Never ask for the client secret, an access token or a refresh token. Never
  show one, and never pass one as an argument. No step needs one. If Mike pastes
  a secret into the conversation anyway, do not repeat it. Tell him that the
  transcript now holds it, and that he must create a new secret in the
  FreshBooks developer page and run this setup again.
- Never edit the config file yourself. `configure.sh` validates every value
  and saves it.
- Pass a value Mike typed to a script in single quotes. If the value holds a
  single quote, a space or a line break, it is not valid. Say so and ask again.
- When a script fails, show its error message to Mike in one sentence and ask
  how to go on. Never retry a failed step without his pick.
- Write to Mike in short, full sentences. Lead with the answer.

## Step 1: Read the current state

Run `bash "${CLAUDE_PLUGIN_ROOT}/bin/status.sh"`. It prints JSON with these
fields:

- `config_path` and `config_exists`
- `settings`: `human_minutes_per_ai_hour`, `idle_gap_minutes`,
  `rounding_step_hours`, `timezone` and `timezone_follows_system`, when the
  config exists. `timezone` is the zone in use. `timezone_follows_system` is
  true when the config names no zone, so the work day follows the machine,
  and false when the config pins a zone.
- `freshbooks`: `client_id`, `redirect_uri`, `business_id`, `account_id` and
  `mapped_repos`, when the config exists
- `system_timezone`
- `client_secret_saved` and `logged_in`, as true or false only

If the script fails because the config is not valid, show the error and stop.

## Step 2: Choose the steps to run

Each step below is either done or missing:

| Step | Done when |
|---|---|
| Hour settings (step 4) | `config_exists` is true |
| FreshBooks app (step 5) | `freshbooks.client_id` is set |
| Client secret (step 6) | `client_secret_saved` is true |
| Login (step 7) | `logged_in` is true, and `business_id` and `account_id` are set |

Step 3 always runs, because it never changes a config that exists. Setup never
changes the repo mappings in `freshbooks.mapped_repos`.

- If every step is missing, run steps 3 to 8 in order.
- If some steps are done, tell Mike in one or two sentences which steps are
  done, and that the config and its repo mappings stay as they are. Then ask
  one AskUserQuestion with `multiSelect` true: "Which finished steps do you
  want to redo?" Offer only the finished steps. Tell him in the question that
  answering Other with "none" keeps them all. When only one step is finished,
  ask "Redo `<step>`?" with "No" and "Yes" instead. Run each missing step and
  each picked step, in order, and then step 8.

## Step 3: Create the config

Run `bash "${CLAUDE_PLUGIN_ROOT}/bin/init-config.sh"`. It prints `config_path`
and `created`. When `created` is true, tell Mike that the config now exists at
that path. When it is false, the existing config stays unchanged, so say
nothing about it.

## Step 4: Hour settings

Run `status.sh` again for the current values. Show them to Mike as a short
list:

- Billable minutes per hour of agent time (default 20)
- Idle gap in minutes, above which a pause does not count (default 15)
- Rounding step in hours, which each line rounds up to (default 0.25)
- Timezone that decides the work day (default: follow this machine). When
  `timezone_follows_system` is true, write "follows this machine, now
  `<timezone>`". When it is false, write "pinned to `<timezone>`", and add
  that the work day stays on that zone when the machine moves.

Ask: "Keep these hour settings?" with the options "Keep them" and "Change some".

If Mike picks "Change some", ask one AskUserQuestion with four questions. Put
the current value first in each, marked "(current)", and the default second
when it differs. Other takes any value.

1. Minutes per AI hour: 20, 15, 30.
2. Idle gap: 15, 10, 30.
3. Rounding step: 0.25, 0.1, 0.5.
4. Timezone, always with these two options:
   - "Follow this machine": the description names `system_timezone` and says
     that the work day moves with the machine. Mark it "(current)" when
     `timezone_follows_system` is true.
   - "Pin `<zone>`": `<zone>` is `timezone`. The description says the work
     day stays on that zone when the machine moves. Mark it "(current)" when
     `timezone_follows_system` is false.

   Other takes any IANA name to pin, such as `America/Phoenix`.

Save only the values that changed, in one call:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/configure.sh" --human-minutes-per-ai-hour '<n>' --idle-gap-minutes '<n>' --rounding-step-hours '<n>' --timezone '<zone>'
```

For "Follow this machine", pass `--timezone system`. That saves no zone, so
the config follows the machine. For a pinned zone, pass the zone name. A
change between following and pinning counts as a change, even when the zone
name stays the same. The script prints the saved values. Confirm them in one
sentence.

## Step 5: Register the FreshBooks app

First ask for the redirect URI: "Which redirect URI should the FreshBooks app
use?" Offer the current `freshbooks.redirect_uri` first when it is not the
default, then "https://localhost:8080/callback (default)". Other takes another
URI. It must use https, have the host `localhost` or `127.0.0.1`, and carry no
query string, because the login listens for it on this machine. Save it:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/configure.sh" --redirect-uri '<uri>'
```

If the script refuses the URI, show its reason and ask again.

Then show Mike these steps, with the saved URI written out:

1. Open https://my.freshbooks.com/#/developer and create an app, or open the
   one you made before.
2. Set the redirect URI to `<the saved URI>`.
3. Turn on these six scopes:
   - `user:profile:read`
   - `user:projects:read`
   - `user:clients:read`
   - `user:billable_items:read`
   - `user:time_entries:read`
   - `user:time_entries:write`
4. Save the app, and copy its client id. Do not copy the client secret here.

Ask: "Paste the app's client id into Other. The client id is not secret, but
the client secret is, so do not paste that." Offer "Keep the current client id"
first when one is set, and "Stop setup for now". Save the answer:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/configure.sh" --client-id '<client id>'
```

If the answer looks like a secret rather than an id, do not save it. Follow the
pasted-secret rule above.

## Step 6: Save the client secret to the keychain

The secret goes from a macOS dialog straight into the keychain. It never passes
through this conversation, a command argument or a transcript.

Tell Mike that a macOS dialog with a hidden field will open, and that he
pastes the client secret from the FreshBooks developer page there. Ask: "Open
the secret dialog now?" with the options "Open the dialog" and "Skip for now".

On "Open the dialog", run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/store-secret.sh" --dialog
```

On success it prints `client_secret saved to the keychain.` and nothing else.

If the dialog failed or Mike cancelled it, offer the terminal route. Run
`echo "${CLAUDE_PLUGIN_ROOT}/bin/store-secret.sh"` to get the full path of the
installed script, and show Mike the command `bash '<that path>'`. Tell him to run it in a separate terminal window, not with `!` in Claude Code,
because a `!` command runs inside this conversation. The script asks for the
secret with hidden input. Then ask: "Did the script say the secret was saved?"
with the options "Yes, it is saved" and "Stop setup for now".

After either route, run `status.sh` and check that `client_secret_saved` is
true. If it is false, tell Mike and ask whether to try again or stop.

## Step 7: Log in

Tell Mike what happens next, in a short list:

- The browser opens the FreshBooks approval page.
- After he approves, the browser warns once about the local certificate. He
  continues to localhost anyway. In Chrome that is "Advanced" and then
  "Proceed to localhost". In Safari it is "Show Details" and then "visit this
  website".
- The script catches the code by itself and saves the login to the keychain.
  It waits up to 5 minutes.

Ask: "Start the FreshBooks login now?" with the options "Start the login" and
"Skip for now". On "Start the login", run this with a Bash timeout of 330000
milliseconds:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/login.sh"
```

The script prints the approval URL on stderr. If the browser did not open,
show Mike that URL. On success it prints JSON with `logged_in`, `business_id`,
`account_id` and the business `name`.

When it fails:

- If the error says the login has several businesses, it lists each business
  id and name. Ask Mike which business the entries go to, with one option per
  business, and save it with
  `bash "${CLAUDE_PLUGIN_ROOT}/bin/configure.sh" --business-id '<id>'`. Then
  ask whether to run the login again.
- If the error names missing scopes, tell Mike to add those scopes to the app
  in the developer page, and ask whether to run the login again.
- If no callback arrived within 5 minutes, ask whether to run the login again.

## Step 8: Confirm

Run `status.sh` one last time. Setup is complete when `config_exists`,
`client_secret_saved` and `logged_in` are true, and `freshbooks.business_id`
and `freshbooks.account_id` are set.

Report in two or three sentences: whether setup is complete, the business id
and account id, and how many repos are already mapped. If a step is still
missing, name it and say that a rerun of `/workbench-freshbooks-timetracking:setup`
picks it up. When setup is complete, tell Mike that
`/workbench-freshbooks-timetracking:estimate` turns a date range into time
entries.
