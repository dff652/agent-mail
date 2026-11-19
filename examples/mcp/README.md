# MCP configuration examples

Agent Mail exposes its communication tools through the `agent-mail-mcp` stdio executable.

1. Install and initialize Agent Mail with `agent-mail quickstart` or `agent-mail init`.
2. Copy the example for your client and replace every placeholder with an absolute path.
3. Point every participating client at the same project `.agent-mail` directory.
4. Give each client a distinct `AGENT_MAIL_ID`.

The server refuses to create a missing home silently. MCP identity comes from `AGENT_MAIL_ID` and
cannot be overridden by tool arguments. Human approval tools are registered only for the explicit
`human@local` identity.

## Codex and Antigravity

Run `agent-mail quickstart --path <project> --runners codex,antigravity` to create both configurations, then run `agent-mail doctor --path <project> --runners codex,antigravity` to check the home and CLI discovery.

| Runner | Project MCP config | Identity |
|---|---|---|
| Codex | `.codex/config.toml` | `codex@local` |
| Antigravity | `.agents/plugins/agent-mail/mcp_config.json` | `antigravity@local` |

The Antigravity example supplies the MCP portion of the native plugin. Quickstart also writes `plugin.json`, `rules/AGENTS.md`, `skills/agent-mail/SKILL.md`, and root-level `hooks.json`. Lifecycle hooks are empty by default. The bridge polls the Agent Mail outbox to trigger wakes. Antigravity exposes the plugin's `agent-mail` server as `agent-mail_agent-mail`.

For a bounded poll or persistent macOS polling, see the [LaunchAgent examples](../launchd/README.md). Validate the generated Antigravity plugin with `agy plugin validate --strict <project>/.agents/plugins/agent-mail`. [Antigravity plugin documentation](https://antigravity.google/docs/build-plugins)
