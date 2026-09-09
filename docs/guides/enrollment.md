# Guarded connection enrollment

This provider feature prepares a **new identity** on an existing HTTPS Hub.
It is separate from the legacy pairing redemption endpoint and the ordinary
mailbox MCP tools. A browser wizard and its DSH session authorization adapter
are not included in this provider increment.

## Hub operator

Enable the protocol explicitly on a Hub with native TLS:

```bash
agent-mail hub --path /absolute/path/to/mail-home \
  --host 127.0.0.1 --port 7421 \
  --tls-cert /absolute/path/to/hub-cert.pem \
  --tls-key /absolute/path/to/hub-key.pem --require-auth --enable-enrollment
```

Use `agent-mail pair create --as new-agent@local --path /absolute/path/to/mail-home`
to issue a code for a new identity. Existing roster
or token identities are rejected by guarded enrollment. Use the separately
reviewed rotation workflow for an existing identity.

The opt-in provider-to-provider endpoints are:

| POST route | Protected provider input |
| --- | --- |
| `/v1/enrollments/redeem` | `code`, `request_id`, `recovery_proof` |
| `/v1/enrollments/recover` | `request_id`, `recovery_proof` |
| `/v1/enrollments/status` | `enrollment_id`, `recovery_proof` |
| `/v1/enrollments/commit` | `enrollment_id`, `recovery_proof`, `commit_id` |
| `/v1/enrollments/cancel` | `enrollment_id`, `recovery_proof` |

These endpoints reject browser Origin headers and cleartext transport. They
accept bounded JSON bodies with exact fields and return `{ok: true, value}` or
`{ok: false, error}`. Redemption and recovery return a credential only over
this protected provider transport. Never forward those responses to a browser
or model. Status, commit and cancellation return safe state.

Pending enrollment state and credential custody survive process restart.
The Hub sweeps pending cleanup on startup and every minute while enrollment is
enabled or a prior enrollment journal exists. Disabling new enrollment does
not abandon cleanup of credentials already issued. Keep its
protected enrollment journal and credential custody together with the Hub
home when backing up or restoring. Do not manually delete pending journals.
After an abrupt process exit, the existing file-lock implementation waits for
its five-minute stale lease before reclaiming a dead owner's lock. A restart
attempt during that window can fail until the lease expires.

## Embedding management host

The package exports `ConnectionEnrollmentManager` and
`createConnectionManagementListener`. The manager accepts a server-resolved
provider home, authenticated owner, exact approved HTTPS targets and protected
CA configuration. Credentials and recovery proofs stay in provider custody.

The HTTP listener is a mountable adapter, not an authentication service. The
embedding host supplies its session authentication and a callback returning:

```ts
{ principal: authenticatedSubject, csrfValidated: true, canManageTarget: true }
```

Return those flags only after checking the actual request's session, CSRF
token and permission for the selected profile. An absent callback, invalid
origin/host, missing permission or unknown profile fails closed. Do not derive
the principal from a browser field, mailbox identity or MCP caller.

Configure the listener's profile registry with server-owned manager options.
Every HTTP-exposed profile requires an explicit nonempty Hub allowlist. Browser
requests cannot provide home paths, commands, environment variables, token/CA
paths, recovery proofs or activation evidence.

| POST route under `/v1/connection-management/` | Browser JSON fields besides `profile_handle` |
| --- | --- |
| `begin` | `endpoint` |
| `redeem` | `context_handle`, `request_id`, `code` |
| `status` | `enrollment_handle` |
| `commit` | `enrollment_handle`, `expected_config_revision`, `confirmed_agent_id` |
| `cancel` | `enrollment_handle` |
| `activate` | `enrollment_handle` |

All calls require the configured Origin, POST JSON, an authenticated owner and
CSRF validation. Opaque handles are owner/profile-bound. UUID request IDs
identify retries; they do not grant access to another owner's enrollment.
If the browser loses the redemption response, pass the original
`context_handle` as `status.enrollment_handle` to recover the safe state.
The management host retains the actual recovery proof; the context handle
still requires the same authenticated owner and profile.

The joining provider checks TLS without following redirects and verifies the
issued identity through authenticated `/me`. A lost or malformed mutation
response has an unknown outcome; reconcile the recorded operation before
attempting another enrollment. Errors expose safe codes and stages, not raw
protected paths or credentials.

## Save, activation and cleanup

Saving uses a revision derived from the exact connection file bytes, so a
concurrent command or manual edit cannot be overwritten with a stale revision.
Save and activation are separate states. Without host evidence from the
intended running provider process, a saved connection remains
`restart_required`. Saving `connection.json` alone does not enable the MCP
process's remote mode.

The optional server-side activation verifier must check the effective route
and identity of that process. The HTTP API accepts only an enrollment handle
for activation. Directory reads and explicit test messages remain ordinary
mailbox operations after activation; directory errors do not authorize another
redemption, and a pending receipt does not establish recipient presence.

Cancellation is limited to pending enrollment and removes only state still
owned by that enrollment. Later independent changes must survive; conflicts
are reported for operator reconciliation. Preserve the previous connection
and credential until the new process is accepted. A deliberate restore must
also compare the current revision before replacing configuration.

A pending identity and credential can already be usable at the Hub before the
joining profile is saved. Closing the browser does not cancel that ownership;
explicit cancellation or the Hub's expiry cleanup resolves it.

## Validation scope

Run the package's build, lint, typecheck and full test suite. Focused tests are
`enrollment.test.ts`, `connection-enrollment.test.ts`,
`enrollment-http.test.ts`, `enrollment-client-http.test.ts`,
`connection-management.test.ts`, `connection-management-e2e.test.ts`,
`enrollment-crash.test.ts`, `enrollment-lock-order.test.ts` and
`enrollment-e2e.test.ts`.

The end-to-end test uses disposable homes, native TLS and a real provider MCP
subprocess. DSH browser integration, production deployment, automatic wake and
presence are separate acceptance gates. Local builds and packs do not publish
or deploy the feature.

Crash tests terminate an actual child process after selected durable writes.
They age only that dead child's lock metadata to simulate expiration of the
existing stale lease; they do not claim immediate restart recovery.
