# Changelog

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
