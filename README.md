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
| `whoami` · `inbox [--all]` | identity, tickets waiting for you |
| `open` · `reply` · `conclude` · `sign` | agent work |
| `decide` | human decision: approve · park · reject |
| `state` | `discussing` (reopen / raise level) · `in-spec --ref TAG` · `conformed --ref TAG` |
| `index` · `check` · `submit` | regenerate INDEX, validate, ship as PR |

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
