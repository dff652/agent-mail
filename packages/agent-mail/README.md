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

Guarded new-identity enrollment is opt-in with `agent-mail hub --enable-enrollment`
and native HTTPS. The package exports `ConnectionEnrollmentManager` and a
host-mounted `createConnectionManagementListener`; the embedding host must
supply authenticated session, CSRF and per-profile authorization. No enrollment
operation is exposed as an ordinary MCP tool. Saving a connection and activating
a running provider process are separate operations.

## License

Apache-2.0. This package includes its own `LICENSE` and `NOTICE` files.

### Optional authenticated DSH management

The `agent-mail/dsh-management` host module mounts authenticated connection
management separately from mailbox MCP tools. Configure the operator, exact
browser origin, permitted profiles and HTTPS Hub targets in a private file.
See [the management guide](../../docs/guides/dsh-management.md) for setup and
activation evidence. No host module is enabled by installing this package alone.
