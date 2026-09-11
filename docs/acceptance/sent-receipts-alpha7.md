# Sent receipts: alpha.7 candidate acceptance

`agent-mail@1.0.0-alpha.7` adds sender-scoped sent history and agent details to
the local MCP and authenticated Hub paths. `comm_sent` and `comm_agent_details`
support durable UI history without treating transport acknowledgment as task
completion. Task state applies to original tasks; reply and completion
notifications retain their own delivery state. Device name/IP and continuous
presence remain unknown without trusted registration and heartbeat data.

## Verified on 2026-09-11

The provider archive SHA-256 is
`8d541c25756f7eb566ee6a2d7993f1314345a3ee57515c435245e61877106b98`.
All 117 archive files matched a clean installed copy byte for byte.

- Lint, typecheck, build, contracts, installer regression and pack dry-run passed.
- The full suite passed: 43 test files, 312 tests. Boundary tests cover sender
  isolation, tied-timestamp pagination, task versus notification status and
  database reads while another connection holds a writer lock.
- Real local MCP and separate clients through authenticated TLS passed sender
  isolation, pre-send details, claim/done/ack, client restart and Hub recovery.
  This TLS test ran on one machine.
- The unified DSH plugin candidate `0.2.0` consumed the exact installed provider
  in real-browser checks for persistent history and automatic receipt updates.

The complete plugin integration evidence and migration plan are maintained in
[the unified candidate acceptance document](https://github.com/dff652/deepseek-harness-community-plugins/blob/main/docs/agent-mail-unified-candidate.md).
That document is part of the companion candidate source and may not be visible
at the remote URL until its source commit is pushed.

## Pending cross-host gate

Two hosts passed read-only SSH, routing and runtime preflight. Application-level
connectivity on the temporary TLS port has not been tested. Host A will run a
disposable Hub and DSH profile; Host B will use an independent MCP identity and
mailbox home. Install native dependencies separately on each target.

Verify bidirectional send, claim/done/error/ack, sender isolation, client and Hub
restart, disconnect recovery, UI updates and durable history. Retain sanitized
version/digest evidence and remove temporary processes and credentials. Do not
modify existing production profiles, services or firewall/router policy.

Host B preparation/client checks can be delegated to one `luna-worker`; the
primary agent owns integration, complete diff review and independent final
verification. Record passed, failed and unrun checks explicitly. Source commit,
push, release/publication and production deployment remain separate decisions.
