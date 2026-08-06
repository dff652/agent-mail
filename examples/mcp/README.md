# MCP configuration examples

Agent Mail exposes its communication tools through the `agent-mail-mcp` stdio executable.

1. Install and initialize Agent Mail with `agent-mail quickstart` or `agent-mail init`.
2. Copy the example for your client and replace every placeholder with an absolute path.
3. Point every participating client at the same project `.agent-mail` directory.
4. Give each client a distinct `AGENT_MAIL_ID`.

The server refuses to create a missing home silently. MCP identity comes from `AGENT_MAIL_ID` and
cannot be overridden by tool arguments. Human approval tools are registered only for the explicit
`human@local` identity.
