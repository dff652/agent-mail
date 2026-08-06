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
