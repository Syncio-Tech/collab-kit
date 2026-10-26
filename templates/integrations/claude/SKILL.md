---
name: collabkit
description: Work the spec <-> implementation conversation channel (collabkit) - check the inbox, open a ticket, reply to a turn, write or sign a conclusion, submit. Use when the user mentions collabkit, a SYNC ticket, the conversation channel, or asks to raise a design issue with the other party.
---

# collabkit

The channel lives in the spec repo under `{{conv}}/`. All state is files; the `collab`
CLI does every mechanical step. Your identity is resolved from `.collabkit/local.yml` or
`.collabkit/link.yml` (or pass `--as <id>`).

## Every session
1. `git -C {{spec_repo}} pull`
2. `collab inbox` - list what waits for you. Report it to the human.

## Raise an issue (open)
Only when you found a real gap between spec and code, a design error, or the spec cannot be
implemented as written - and you can point to a requirement.
```
collab open --title "<one sentence>" --level T2 --reason "<which level criterion>" \
  --requirement "<who asked, where, when | NO_REQUIREMENT>" --spec-ref "<file#ID @ tag>"
```
Then fill the sections of the created `ticket.md` (Problem, What the spec says, What the code
does, Evidence, Impact). Evidence must be reproducible; label estimates.

## Reply
```
collab reply SYNC-007 --points P1,P2
```
Fill one section per point: agree / disagree / need data, with reasons and evidence. The CLI
refuses a reply when you already used the turn limit on a point - then escalate instead:
`collab state SYNC-007 discussing --level T2`.

## Conclude and sign
- `collab conclude SYNC-007` creates `99-conclusion.md` (or reuses it). Write: the common
  conclusion, open disagreements as options with trade-offs, rejected alternatives.
- Each agent signs once it agrees the conclusion is fair: `collab sign SYNC-007`.
  When both agents signed, the ticket becomes `agreed` and waits for the deciding human.

## Submit
`collab check` then `collab submit SYNC-007`. In `agent_push` mode this creates a
branch and a PR; in `human_commit` mode it prints the commands for your human.

## Never
Lower a level, edit someone else's turn, touch files outside `{{conv}}/` in a conversation
change, write secrets, merge, or push to `main`.
