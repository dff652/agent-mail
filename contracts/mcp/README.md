# mcp

MCP tool name/parameter snapshots (R0+).

`comm_sent` and `comm_agent_details` are additive authenticated read surfaces.
The former is sender-scoped and reports durable delivery/task evidence; the
latter keeps device and recipient liveness fields unknown without trusted
registration or heartbeat evidence.
