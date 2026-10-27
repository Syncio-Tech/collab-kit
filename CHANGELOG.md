# Changelog

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
