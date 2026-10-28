# Changelog

## 0.4.3 - 2026-10-28
- **No stray git lock files.** Every git call runs with `GIT_OPTIONAL_LOCKS=0`, so `check` / `next` / `inbox` never
  take `.git/index.lock` (git refreshes the index opportunistically on `diff` / `status`). Every fetch, pull and
  commit runs with `maintenance.auto=false` and `gc.auto=0` (no `objects/maintenance.lock`), and fetch does not write
  `FETCH_HEAD`. Matters where a folder cannot delete files (e.g. an agent in a connected folder): a lock left behind
  used to block the human's next commit.
- **`COLLAB_NO_FETCH=1` / `--no-fetch`**: read commands (`next`, `inbox`, `status`, `log`, `viz`, `activity`) never
  fetch; "behind origin" is computed from what is already known.
- Commands that never call git, safe for an agent that must not touch git: `open`, `reply`, `conclude`, `sign`,
  `state`, `decide`, `index`.
- `collab --version` works (it ran `next` before).
- `init` with `--spec-github` and `--impl-github` no longer tells you to replace CODEOWNERS handles, and drops the
  "replace the handles" comment. `init` and `link` add `.claude/settings.local.json*` to `.gitignore`.

## 0.4.2 - 2026-10-28
- **Activity log** (`activity_log: on` in config; default off): every `collab` command is recorded with who ran
  it, whether a human or an agent (Claude Code's shell, the runner), flag names, exit code, duration and the first
  line of the error. No ticket text, no free-text arguments, home paths shortened to `~`.
  Kept on this machine first, pushed by `sync` / `ship` / `note` to the spec repo's side branch `collab/activity`
  (one file per party, never merged, no PR).
- `collab note "..."`: write down a friction point the moment it happens.
- `collab activity [--pretty] [--since DATE]`, `collab activity push`.
- `collab viz` adds a friction section: commands per party (agent vs human), failures, failed `check` / `ship`,
  top errors, notes.
- `upgrade` adds the `activity_log` key.

## 0.4.1 - 2026-10-27
- **History, as a standard log.** `collab log` rebuilds every event from git history and the signals branch, as
  CloudEvents 1.0 JSON lines (`tech.collabkit.ticket.opened`, `turn.added`, `level.raised`, `ticket.concluded`,
  `conclusion.signed`, `decision.recorded`, `state.changed`, `spec.released`, `pr.merged`, `reminder.sent`,
  `runner.*`). Nobody writes the log by hand; each event names its actor and its commit. Bypasses show up as
  anomalies: `state.reverted`, `turn.edited`, `file.removed`, `level.lowered`, `conclusion.edited`.
  Filters: `--ticket 4`, `--since`, `--type`, `--pretty`, `--out`.
- **`collab viz`**: one self-contained HTML file (no network, light/dark): timeline of every ticket coloured by
  who it waited on, the conversation of one ticket across the five lanes, waiting hours per party, human decisions,
  the raw events. Default `~/.collabkit/viz/<project>.html`; `--open`.
- Claude integration adds the `collabkit-history` skill (draw and explain the history).
- The runner records its own events (`runner.agent_called`, `runner.pushed`, `runner.discarded`,
  `runner.skipped`) on the signals branch.
- Fix: `collab auto install` keeps the PATH of the terminal that runs it (plus `~/.local/bin`), so launchd finds
  `claude`. Re-run `collab auto install` after upgrading.
- Fix: the runner passes `COLLABKIT_AS` to the agent.

## 0.4.0 - 2026-10-27
- **Semi-auto** (`autonomy: semi` in config; default `manual`; full auto is refused). The transport runs by
  itself; decisions, spec changes and code stay human.
  - `collab auto register | install | now | run | uninstall`: a runner on your machine (launchd on macOS, low
    priority, every 15 min; `now` runs at once and restarts the cycle). Own clone under `~/.collabkit/work/`, one
    run at a time, daily agent budget, timeout. Calls the agent headless only for conversation steps; keeps only
    `conversation/` changes that pass `check`; pushes `conv/auto-*`; never calls again while that branch is open.
  - Workflow `collab automerge`: checks `conv/auto-*` branches (autonomy read from main, `conversation/` only,
    `collab check --pr --actor`) and squash-merges them.
  - Branch `collab/signals`: heartbeat, ack, remind. Concurrent writers merge (retry on race).
  - Reminders after `remind_after_hours` (T3 2h, T2 24h, T1/T0 72h), once per wait, for whoever the ticket waits
    on. Workflow `collab signals` + `collab notify` turn them into an issue comment @mentioning that login, so
    GitHub sends the email. Signals pushed under another party's login are rejected.
  - `collab status`: runners last seen, tickets waiting, seen / reminded.
  - `upgrade` adds the two workflows and the `autonomy` key.

## 0.3.1 - 2026-10-27
- `ship` refuses changes outside `conversation/` (it used to commit the ticket part and leave the rest), and
  refuses rule/config/template-only changes: commit those by hand.

## 0.3.0 - 2026-10-27
- **Identity is verified, not declared.** `parties.<role>.github` in config maps each party to a GitHub login.
  CI runs `collab check --actor <login>`; a new ticket, turn, signature or decision for an id must be pushed by that
  id's party login (`identity-mismatch`). Before, anyone could write `--as <human>`.
- **`collab next`**: what is waiting for you, with the exact commands, per state. Agents start every session with it,
  so prompts shrink to "follow collab next".
- **`collab upgrade`**: repins the CI workflow, refreshes the README rules block, untouched templates and agent
  files, and adds config keys introduced since setup (comments kept). Tickets are never touched.
- CI workflow also runs on pushes to `main` (an alarm when something lands without a PR on plans where rulesets
  are not enforced). Upgrade the workflow with `collab upgrade`.
- Paths in printed commands are relative and quoted (spaces in folder names broke copy-paste).
- **Shorter, linear workflow** (feedback: too many long commands, too much guidance needed):
  - `collab` with no command = `collab next`.
  - `collab sync`: spec repo to the default branch and pulled; refuses on uncommitted ticket changes; lists merged
    local branches to delete.
  - `collab ship`: the human's one command - check, branch, commit, push, PR link. Agents in `human_commit` mode
    end with "run `collab ship`" instead of printing git commands.
  - Short ticket ids everywhere: `4`, `004`, `sync-4` = `SYNC-004` (`collab decide 4=A 5=B ...`).
  - Help, README and the rules block are ordered as one round: sync -> agent -> ship -> merge.

## 0.2.0 - 2026-10-27
Rules learned from the first real project run (two agents, one human, three tickets end to end).
- **A spec change is decided by the spec owner's human, whatever the level.** `state in-spec` refuses otherwise;
  `check` reports `spec-change-decider`. Before, a T0/T1 approved by the implementer's human could change the spec.
- **Signatures cover the conclusion text.** `sign` stores `{at, sha256}`; editing the conclusion afterwards voids
  the signature (`signature-stale`), and `agreed` needs both signatures to match the current text. Pre-0.2
  signatures (bare timestamps) are reported as `signature-legacy` warnings. `sign` refuses an empty conclusion.
- **No endless back-and-forth.** `max_turns_per_ticket` (6) and `max_points_per_ticket` (5) in config;
  `reply` refuses past the caps (`turn-cap`, `point-cap`). When the other side's last turn agrees on every point,
  `reply` refuses and points to `conclude`; `check` warns `should-conclude`.
- `decide` takes several tickets at once: `collab decide SYNC-001=A SYNC-002="B1+B2" --decision approve`.
  Validates all before writing any.
- `inbox` warns when the spec repo is not on the default branch or is behind origin.
- `submit` names the branch after every ticket it carries (`conv/SYNC-001-003-...`) and prints the GitHub
  compare link when `gh` is not installed.
- README: Limitations (GitHub Free does not enforce rulesets on private repos).

## 0.1.2 - 2026-10-27
- New rules `turn-unfilled` and `ticket-unfilled`: `check` (and therefore `submit` and CI) fails when a turn still
  holds the template text, or a ticket's Problem / Evidence section is empty. Found in a real run: an agent created
  three turns with `collab reply`, never wrote them, and reported them as answered.
- `reply` now says the file must be written before submitting.

## 0.1.1 - 2026-10-27
- Fix: `mixed-pr` fired on the `collab init` PR. It now applies only to PRs that change a ticket folder
  (`conversation/SYNC-nnn/`); setup and rule changes may touch other files.
- Fix: `collab ... | head` no longer crashes with EPIPE.

## 0.1.0 - 2026-10-26
- Command `collab` (alias `collabkit`), package `collabkit-cli`.
- First version: `init`, `link`, `whoami`, `inbox`, `open`, `reply`, `conclude`, `sign`, `decide`, `state`, `index`, `check`, `submit`.
- Integrations: `generic` (AGENTS.md), `claude` (CLAUDE.md + skill).
- Rules: required fields, levels only raised by agents, append-only turns, state transitions, decisions by the right human, turn limit per point with escalation, NO_REQUIREMENT parks, secrets and forbidden patterns, mixed PRs, weekly cap, INDEX freshness.
