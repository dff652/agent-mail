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

## Read surfaces

The MCP server provides two additive, read-only views for clients that need to
render durable coordination state:

- `comm_sent({ limit?, before? })` returns only messages sent by the caller.
  Each item contains the raw local `delivery_status` and `task_status`, a
  derived `status` (`submitted`, `claimed`, `processing`, `completed`,
  `failed`, or `unknown`), and `status_evidence`. When paging, pass the
  returned `next_before` cursor (`<sent_at>|<message_id>`) to avoid skipping
  messages with the same timestamp.
- `comm_agent_details({ agent_id? })` returns roster identity and safe
  connection metadata for the caller or a roster agent. `hub_endpoint` is the
  Hub URL; it is never presented as a device IP. This provider has no trusted
  device registration or heartbeat source, so `device_name` and `device_ip`
  are `null`, and recipient `connection`/`last_seen` remain `unknown`/`null`.
  `fields_unknown` lists each response field that is null or unknown.

The same views are available through authenticated `GET /v1/mail/sent`,
`GET /v1/mail/me/details`, and `GET /v1/mail/agents/{agent_id}/details`.
The sent endpoint derives the sender from the bearer token and rejects query
identity overrides. Existing mailbox tools and routes remain unchanged.

## License

Apache-2.0. This package includes its own `LICENSE` and `NOTICE` files.

### Optional authenticated DSH management

The `agent-mail/dsh-management` host module mounts authenticated connection
management separately from mailbox MCP tools. Configure the operator, exact
browser origin, permitted profiles and HTTPS Hub targets in a private file.
See [the management guide](../../docs/guides/dsh-management.md) for setup and
activation evidence. No host module is enabled by installing this package alone.
