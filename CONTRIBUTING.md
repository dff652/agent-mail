# Contributing to Agent Mail

Agent Mail is a TypeScript developer preview. Focused fixes, tests, documentation corrections,
security hardening, and bounded feature proposals are welcome. Open an issue before a large protocol,
storage, federation, TUI, or trust-model change.

## Development setup

Node.js 20 or newer is required.

```bash
npm --prefix packages/agent-mail ci
npm --prefix packages/agent-mail run check
bash scripts/run_contracts_ts.sh
bash scripts/release_check_ts.sh
```

## Pull requests

- Keep each change bounded and explain user-visible behavior and security implications.
- Update contracts or protocol references before implementations when wire or data semantics change.
- Add tests for behavior changes and run the relevant gates.
- Keep tokens, cookies, login state, SQLite runtime data, message content, machine-specific paths,
  and non-public topology out of commits and fixtures.
- Do not describe a local candidate or test result as a published release or deployed capability.
- Maintainers retain manual control of merges, tags, publishing, and deployments.

Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
