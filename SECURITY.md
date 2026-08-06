# Security policy

Agent Mail handles task content, bearer tokens, local SQLite state, optional remote Hub traffic,
and bridges that can invoke coding agents. Please do not put credentials, private message bodies,
certificate keys, or private topology in a public issue.

## Supported versions

The project is currently a developer preview and has not published a public alpha Release. Until a
public Release exists, security fixes target the current `main` branch on a best-effort basis. This
policy will be updated with an explicit supported-version table before a stable release.

## Reporting a vulnerability

After the repository becomes public and private vulnerability reporting is enabled, use
[GitHub private vulnerability reporting](https://github.com/dff652/agent-mail/security/advisories/new).
If that channel is unavailable, open a public issue containing only a request for a private contact
channel—do not include vulnerability details.

Please include affected versions or commits, impact, reproduction conditions, and whether the
report involves a remote Hub, federation, wake bridge, or local-only operation. No response-time or
fix-time SLA is currently offered.

The full threat model, deployment requirements, trust boundaries, and current limitations are in
[docs/architecture/SECURITY.md](docs/architecture/SECURITY.md).
