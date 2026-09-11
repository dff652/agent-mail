# Remote Hub

Remote Hub access expands the trust boundary. Before binding beyond loopback:

- review the [security model](../architecture/SECURITY.md);
- configure TLS and scoped bearer tokens;
- restrict the listener with a firewall or private overlay network;
- keep operator approval enabled for write-capable workflows;
- run `agent-mail doctor` from both the Hub host and each client environment.

Never publish tokens, certificates, message content, or network topology in configuration examples.
Federation peers should have separate credentials so one peer can be revoked without rotating every
client.

Authenticated clients can use `GET /v1/mail/sent` (or MCP `comm_sent`) to
read their own durable sent history. The Hub derives the sender from the
bearer token and does not accept `as`, `agent_id`, `from`, `sender`, or
`recipient` query overrides. Delivery and task state are read from the
existing SQLite rows; a transport acknowledgement from a federation peer is
not reported as recipient task completion.

`GET /v1/mail/me/details` and
`GET /v1/mail/agents/{agent_id}/details` (or MCP `comm_agent_details`) expose
roster identity and the authenticated Hub endpoint. The endpoint identifies
the Hub, not the client device. Until a trusted device registration or
heartbeat is available, device name/IP and recipient online state are
reported as unknown (`null` fields and `connection: "unknown"`).
