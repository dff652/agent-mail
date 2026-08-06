# Local Hub

Initialize a project and start a loopback-only Hub:

```bash
agent-mail quickstart
agent-mail hub --host 127.0.0.1
```

Run `agent-mail doctor` before connecting clients. Keep `.agent-mail/` out of source control. A local
Hub is the recommended first deployment because it does not expose the API to the network.

Use the MCP examples in [`examples/mcp/`](../../examples/mcp/) for stdio clients that share the same
project home.
