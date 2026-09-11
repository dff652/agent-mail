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

## Cross-host isolated acceptance on 2026-09-11

Host A ran a disposable authenticated TLS Hub and DSH profile. Host B used an
independent MCP identity and mailbox home with natively compiled SQLite
bindings. The temporary CA and IP SAN were validated; TLS verification stayed
enabled. The selected port was reachable without changing firewall or router
policy.

Independently verified: bidirectional send, sender isolation, claim, done,
error, ack, original-task versus notification delivery state, MCP restart,
Hub disconnect fail-closed, Hub restart recovery, UI history after reload,
and automatic claim/completion updates. Device name/IP and continuous
presence remained unknown. Existing production profiles were not modified.

The first Host B `type=error` attempt used the origin of a B→A task and was
rejected (`done/error must be sent by the assignee to the task origin`). The
primary agent retested as assignee on both directions: the original task
became `failed` while the error notification stayed a delivery receipt. The
Host B worker missed the Hub-down window; the primary agent still observed
connection refused without fabricated receipts, then recovered sent history
after restart.

The Host B `luna-worker` type was unavailable in the session that ran this
gate; one general-purpose subagent used the same Host B ownership contract.
That is not a claim that `luna-worker` ran. A worker summary alone was not
treated as acceptance. Item-by-item evidence is in the companion
[cross-host closeout](https://github.com/dff652/deepseek-harness-community-plugins/blob/main/docs/agent-mail-acceptance-closeout.md).

Sanitized version/digest evidence is retained outside this repository.
Temporary processes and credentials were removed. Source commit, push,
release/publication and production deployment remain separate decisions.
