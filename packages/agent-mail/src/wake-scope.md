# Wake bridge scope (TS)

**Status**: P5 runner and P6 webhook/SSE development gates implemented locally.
Real-client acceptance and the unified P4–P8 PR/main CI are still open.

| Capability | TS now | Notes |
|------------|--------|--------|
| `outbox_events` on send / approval decision (same txn) | yes | `SqliteStore.sendMessage` / `setApproval` |
| list / ack consumer cursor | yes | store + `GET /v1/events` · `POST /v1/outbox/ack` |
| dual-gate (write needs approval + `--allow-write`) | yes | `domain/wake-gate.ts` |
| coalesce + single recipient runner | yes | latest event + cross-process lock |
| `agent-mail bridge --dry-run` | yes | prints plan/command; no model process |
| Live `codex` / `grok` / `claude` adapters | local development gate | constrained command, MCP identity preflight, timeout/cancel, state verification |
| Signed webhook doorbell | local development gate | HMAC, skew/nonce replay guard, body-free backfill |
| SSE long-poll wait loop | local development gate | wait/cancel/idle timeout, strict frames, 64 KiB, application connection slots |

```bash
# No model call and no cursor movement
agent-mail bridge --path /project --recipient codex@local --runner codex --dry-run

# Live local-store checkpoint (may consume provider quota)
agent-mail bridge --path /project --recipient codex@local --runner codex
```

The runner adapters have deterministic fixture evidence only. P6 webhook/SSE
has local negative and shared-wire-contract evidence, but is not yet merged.
Codex/Grok real calls
require explicit cost authorization; Claude real-host acceptance remains
deferred by the recorded organization HTTP 403. Until those runs and the
unified P4–P8 PR/main CI complete, this is not an accepted alpha capability.
