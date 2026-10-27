---
name: collabkit-history
description: Show and explain the collaboration history of the collabkit channel - who said what, who waited on whom, what the humans decided. Use when the user asks for the history, a timeline, a log, a visualization of the agents' collaboration, bottlenecks, or "what happened on SYNC-nnn".
---

# collabkit history

The log is rebuilt from git history (and the `collab/signals` branch); nobody writes it by hand.
Every event is a CloudEvents 1.0 object: `type` = `tech.collabkit.<noun>.<verb>`, `subject` = ticket id,
`data.actor` = who did it, `data.commit` = the evidence.

## Draw it
```
collab viz --open
```
One self-contained HTML file (default `~/.collabkit/viz/<project>.html`): a timeline of every ticket coloured
by who it was waiting on, the conversation of one ticket as a sequence between the five lanes
(human / agent on each side, git / CI), waiting hours per party, and every human decision.
Give the user the path it printed. Do not commit the file.

## Explain it
```
collab log --pretty                 # one line per event
collab log --ticket 4 --pretty      # one ticket
collab log --type decision.recorded # JSONL, for counting
```
Then report, in a few lines:
- where time went: which party each open ticket waited on longest (the bottleneck);
- turns per ticket against the caps ({{max_turns}} per point), and tickets that escalated a level;
- human decisions: who, which option, how long after the ticket opened;
- anomalies (`state.reverted`, `file.removed`, `turn.edited`, `level.lowered`, `conclusion.edited`): name the
  commit; these mean a rule was bypassed or history was rewritten.
State facts from the log only; do not guess intent.
