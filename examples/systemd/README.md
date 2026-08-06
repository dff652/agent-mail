# systemd unit examples (optional)

Agent Mail does **not** bundle or install systemd. These units are templates for operators who want a long-running Hub and/or L3 federation worker on Linux.

| Unit | Purpose |
|------|---------|
| `agent-mail-hub.service` | HTTPS Hub (`store.sqlite` authority) |
| `agent-mail-federation-worker.service` | Push/pull peer sync loop |

## Quick start (user units)

```bash
# 1. Init home + domain/peers as usual (see docs/guides/hub-remote.md)
export AGENT_MAIL_PROJECT="$HOME"   # project root; state is .agent-mail/

# 2. Copy and edit units
mkdir -p ~/.config/systemd/user
cp examples/systemd/agent-mail-hub.service \
   examples/systemd/agent-mail-federation-worker.service \
   ~/.config/systemd/user/
# Edit ExecStart paths, certs, interval

# 3. Ensure agent-mail is on PATH for the user session
which agent-mail

# 4. Enable
systemctl --user daemon-reload
systemctl --user enable --now agent-mail-hub.service
systemctl --user enable --now agent-mail-federation-worker.service

# 5. Health
agent-mail federation status --path "$AGENT_MAIL_PROJECT"
cat "$AGENT_MAIL_PROJECT/.agent-mail/logs/federation_health.json"
journalctl --user -u agent-mail-federation-worker -f
```

## Alerts / lag

After each sync tick the worker writes `logs/federation_health.json`:

- `ok: false` when pending lag exceeds `AGENT_MAIL_FED_LAG_ALERT_SEC` (default 300s), dead letters exist, or the last sync had errors
- `federation status` exits **1** when `ok` is false (useful for cron/monitoring)

Dead letters:

```bash
agent-mail federation dlq list --path "$AGENT_MAIL_PROJECT"
agent-mail federation dlq requeue --all --path "$AGENT_MAIL_PROJECT"
```

## Hub token rotation (no downtime)

```bash
# User hub-token: dual-hash grace
agent-mail hub-token rotate --as alice@ws --path "$AGENT_MAIL_PROJECT"
# distribute new token; both old and new work
agent-mail hub-token revoke-previous --as alice@ws --path "$AGENT_MAIL_PROJECT"
```

Current TS federation peer-token rotation does not yet have a supported CLI
workflow. Schedule a coordinated peer re-enrollment rather than editing
`auth/federation_*.json` by hand.

F4 (envelope signatures / mTLS) is intentionally out of scope for these units.
