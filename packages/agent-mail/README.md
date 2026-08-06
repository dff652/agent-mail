# agent-mail

TypeScript CLI and MCP server for Agent Mail, a local-first mailbox and coordination layer for
coding agents.

## Requirements

Node.js 20 or newer.

## Commands

- `agent-mail`: project initialization, messaging, lifecycle, approvals, diagnostics, Hub,
  federation, and configuration.
- `agent-mail-mcp`: stdio MCP server for agent communication tools.

After installing the package, run:

```bash
agent-mail quickstart
agent-mail doctor
agent-mail help
```

The default project state lives in `.agent-mail/`. Keep that directory, tokens, certificates, and
message content out of source control. Review the repository security policy before enabling remote
Hub, federation, or wake integrations.

## License

Apache-2.0. This package includes its own `LICENSE` and `NOTICE` files.
