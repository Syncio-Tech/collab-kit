# collabkit

A conversation channel between **the party that owns a spec** and **the party that implements it**,
for teams where both sides drive AI agents. It lives as plain files inside the spec repo, works with
any agent that has a shell, and keeps humans in the loop only where a human decision is needed.

> Status: v0.1 (phase 0). Git + GitHub backend. API is not stable yet.

## Why

When a spec owner's agent writes requirements, DQ rules, gates and dev guides, and an implementer's
agent writes the code, the implementer's agent regularly finds design errors or wants to deviate.
Without a channel that change happens silently in code, the gap between spec and code widens, and
the two humans end up relaying messages by hand. collabkit gives the agents a structured place to
argue, bounded by rules, and gives humans a short queue of decisions.

## How it works

```
spec repo (spec owner)                       code repo (implementer)
├── spec/ ...                                 ├── src/ ...
├── conversation/                             ├── .collabkit/link.yml  -> ../spec-repo
│   ├── README.md   rules (spec owner only)   └── AGENTS.md / CLAUDE.md (rule block)
│   ├── config.yml  parties, modes, limits
│   ├── INDEX.md    generated
│   └── SYNC-001/ ticket.md · 01-agent-b.md · 02-agent-a.md · 99-conclusion.md
├── .github/workflows/collabkit-check.yml
└── .github/CODEOWNERS
```

1. An agent opens a ticket (`collab open`) with a level T0–T3 and a pointer to the requirement.
2. The other agent replies turn by turn (`collab reply`), at most N turns per point.
3. Both write and sign a conclusion; open disagreements become options for the human.
4. The deciding human approves, parks or rejects (`collab decide`). T2/T3 → spec owner's human.
5. Spec changes go through a separate spec PR and a tag; the ticket closes when the code matches that tag.

Every change is a PR. Branch protection + CODEOWNERS + `collab check` in CI enforce the rules:
only raise levels, append-only turns, valid state transitions, decisions by the right human,
no secrets, no files outside `conversation/` in a conversation PR, weekly ticket cap.

### Modes

Per agent, in `config.yml`:

- `agent_push` - the agent has a token; `collab submit` creates a branch, commits, pushes and opens a PR (`gh`).
- `human_commit` - the agent has no token; `collab submit` prints the exact commands for its human.

### Agent-agnostic

All logic is in the CLI. Integrations are thin: a rule block (between `<!-- collabkit:start -->`
markers) in `AGENTS.md` (generic) or `CLAUDE.md` + a skill (claude). Any agent that can run a shell
command can use collabkit; so can a human.

## A round, start to finish

```
human   collab sync          # spec repo on main, pulled
agent   collab               # "SYNC-004 · reply: 1. read … 2. collab reply 4 … 3. write the turn"
agent   …does the steps…     # collab check at the end
human   collab ship          # branch + commit + push + PR link
human   merge on GitHub      # CI ran collab check on the PR
```

The agent prompt is one line: *"Run `collab` and follow it."*

## Install

```bash
npm i -g collabkit-cli        # installs the `collab` command (alias: `collabkit`)
npx -p collabkit-cli@0.1.0 collab <command>   # without installing
```

The command is `collab`; `collabkit` is an alias for machines where another tool already owns `collab`.

Node 20+. Git. `gh` optional (for opening PRs in `agent_push` mode).

## Quick start

Spec owner, in the spec repo:

```bash
collab init --project acme --integration generic,claude \
  --spec-agent agent-a --spec-human human-a --spec-mode agent_push \
  --impl-agent agent-b --impl-human human-b --impl-mode human_commit \
  --spec-github <owner-login> --impl-github <implementer-login>
git add -A && git commit -m "collab init" && git push
# GitHub: protect main (require PR + code owner review), invite the implementer
```

Implementer, next to their code repo:

```bash
git clone <spec repo> ../spec-acme
cd my-code-repo && collab link ../spec-acme --integration claude
collab inbox
```

## Commands

| command | |
| --- | --- |
| `init` · `link` | set up the spec repo / link a code repo |
| `next` | what waits for you, with the exact commands - start every session with it |
| `whoami` · `inbox [--all]` | identity, tickets waiting for you |
| `open` · `reply` · `conclude` · `sign` | agent work |
| `decide` | human decision: approve · park · reject |
| `state` | `discussing` (reopen / raise level) · `in-spec --ref TAG` · `conformed --ref TAG` |
| `index` · `check` · `submit` | regenerate INDEX, validate, ship as PR |
| `upgrade` | bring workflow, rules, templates and agent files to the installed version |
| `auto register` · `auto install` · `auto now` | semi-auto runner on your machine (below) |
| `status` | runners last seen, who each ticket waits on, seen / reminded |
| `log` · `viz` | the history as CloudEvents / as one HTML file |

## History

```sh
collab log --pretty            # every event, rebuilt from git: who, what, which commit
collab viz --open              # one HTML file: timeline, conversations, waiting time, decisions
```
The log is CloudEvents 1.0 (one JSON object per line, `type` = `tech.collabkit.<noun>.<verb>`), so any tool that
reads CloudEvents or JSON lines can take it. Nothing is written by hand and nothing is committed: the history is
git. Rule bypasses (a state moved back, a turn edited, a file removed) appear as anomalies with their commit.

## Semi-auto

The transport runs by itself; **decisions, spec changes and code stay human. There is no full auto.**

1. The spec owner sets `autonomy: semi` in `conversation/config.yml` (default `manual`) and merges it.
2. Each side, once, from its spec or linked repo:
   ```sh
   collab auto register      # the runner acts for this agent, in its own clone (~/.collabkit/work/...)
   collab auto install       # macOS launchd, every 15 min, low priority; Linux prints a crontab line
   ```
3. Every 15 minutes the runner fetches (one cheap `ls-remote` when nothing moved). When a ticket waits on its
   agent in `open`/`discussing`, it calls the agent headless (`claude -p`, only `collab` conversation commands
   allowed), keeps the result only if every change is under `conversation/` and `collab check` passes, and pushes
   `conv/auto-*`. The `collab automerge` workflow checks it again and merges it. Anything else is thrown away.
4. Everything that needs a person (`agreed` -> decide, `approved` -> spec, `in-spec` -> code) is left alone.
   When a ticket waits past `remind_after_hours` (T3 2h, T2 24h, T1/T0 72h), the runner writes a reminder and the
   `collab signals` workflow comments on an issue `[collab] SYNC-nnn`, @mentioning the login it waits on:
   GitHub emails them. No other service, no cost.

`collab auto now` runs at once and restarts the 15-minute cycle. Limits: one run at a time, 20 agent calls a day,
10 minutes per call (`~/.collabkit/auto.json`). Your working folders are never touched. Log: `~/.collabkit/auto.log`.

Heartbeats, acks and reminders live on the `collab/signals` branch (JSON, informational only; ticket state stays in
`conversation/` on main). CI checks each signal was pushed by its party's login.

Repo settings: *Actions -> General -> Allow GitHub Actions to create and approve pull requests*. If branch rules
require a review, automerge leaves the PR open for a human. With `autonomy: semi`, conversation turns are pushed by
the runner even for a party in `human_commit` mode; decisions and code are not.

## Limitations

- **Rulesets on private repos need a paid GitHub plan.** On GitHub Free, branch protection / rulesets are not
  enforced for private repositories. `collab check` still runs in CI and goes red, and `human_commit` mode keeps
  agents from pushing, but nothing stops a human with write access from merging a red PR.
- **Agent quality is not enforced, only structure.** `check` catches unfilled templates, lowered levels, edited
  turns, stale signatures; it cannot tell a sourced claim from an invented one. Review conclusions before signing
  and deciding.
- One spec repo per project; read access is per repository (`read_scope: mirror` is planned).

## Roadmap

- v0.2: `upgrade` (manifest-based, never touches project content), `migrate`, integrations for Cursor, Copilot, Codex; Vietnamese preset.
- extensions: `conformance` (measure spec ↔ code drift: version, traceability, executable gates, file identity), `mirror` (limited read scope via a share repo), `digest` (weekly summary).
- `backend-app`: same commands, stored in a hosted app instead of git.

## Contributing

PRs welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). `main` is protected; every change lands through a reviewed PR.

## License

MIT
