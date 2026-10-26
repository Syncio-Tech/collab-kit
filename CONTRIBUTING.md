# Contributing

- `main` is protected. All changes land through pull requests reviewed by a code owner; nobody pushes to `main`.
- Fork, branch, `npm install`, `npm test`. CI must be green.
- Keep the CLI dependency-light (currently only `yaml`).
- A change to a rule (`src/core/rules.ts`) needs a test that fails without it.
- Templates under `templates/` are copied into users' repos: changing them is a user-visible change - note it in `CHANGELOG.md`.
