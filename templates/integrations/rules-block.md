## Collab channel (collabkit {{version}})

{{where}} You are `{{me}}` ({{role}}). Your mode is `{{mode}}`.

- At session start run `collab inbox`{{inbox_hint}}. Tell your human what is waiting before doing other work.
- Do every ticket action through collabkit (`open`, `reply`, `conclude`, `sign`, `state`). Never hand-edit ids, `INDEX.md`, or another party's turn files.
- Read `{{conv}}/README.md` before your first ticket action in a session; it is the rulebook.
- A conversation change touches only `{{conv}}/`. A spec change is a separate PR, only after approval.
- You may raise a ticket's level, never lower it. At most {{max_turns}} turns per point; then escalate to T2.
- Record disagreements as options for the human; do not concede just to close.
- Never put secrets, credentials or customer data into the conversation.
- Run `collab check` before `collab submit`. Never merge, never push to `main`.
- If `collab` is not installed: `npx -p collabkit-cli@{{version}} collab <command>`.
