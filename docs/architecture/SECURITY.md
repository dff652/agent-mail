# Security model

Agent Mail stores task content, identities, approvals, bearer tokens, and optional TLS material.
Treat `.agent-mail/` as sensitive runtime state and never commit it.

## Trust boundaries

- Local filesystem permissions protect the SQLite store, policy, tokens, and certificates.
- MCP identity is supplied by the process environment and cannot be overridden by tool arguments.
- Human approval tools are available only to the explicit `human@local` identity.
- Remote Hub and federation endpoints require authentication; use TLS for non-loopback traffic.
- Wake bridges can start coding-agent processes and therefore require strict command allowlists,
  replay protection, bounded payloads, and explicit operator review.

## Deployment rules

1. Start in local-only mode and run `agent-mail doctor`.
2. Bind a Hub to loopback unless remote access is deliberately configured.
3. Use distinct scoped tokens for clients and peers; rotate them after suspected exposure.
4. Keep policy defaults at `approve-writes` until the workflow is understood.
5. Back up the complete `.agent-mail/` directory while services are stopped or use a consistent
   SQLite backup procedure.
6. Do not put tokens, message bodies, topology, certificates, or runtime databases in issues or
   fixtures.

## Reporting

Follow the repository [security policy](../../SECURITY.md).
