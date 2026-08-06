# Agent Mail contracts

This directory contains language-neutral, executable contracts consumed by the TypeScript product:

- lifecycle and policy fixtures;
- MCP tool declarations;
- HTTP routes, wire contracts, and security negatives;
- settings registry and JSON Schema;
- user-visible CLI verbs.

The protocol and message/roster schemas live in [`../refs/`](../refs/). Packaged snapshots must stay
byte-identical to their repository sources.

Run the permanent contract gate with:

```bash
bash scripts/run_contracts_ts.sh
```

When behavior changes, update the contract first, update the implementation, and add or adjust a
test. New artifacts must be registered in `manifest.json`.
