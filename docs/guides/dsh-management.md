# Authenticated management in a DSH host

This optional provider module supplies the management boundary required by the
Agent Mail connection wizard. It runs in the DSH host process and uses the
provider's guarded enrollment protocol. The UI bundle contains no provider
implementation or deployment credentials.

## Private configuration

Use a dedicated high-entropy management login secret, separate from any Hub
bearer token or pairing code. Create it locally without printing its value:

```bash
agent-mail management-key init --file /absolute/path/to/management-password
```

The command creates a new private file and refuses to replace an existing file.
Read the file locally when entering the management login form; never place its
contents in a URL, shell argument, shared patch, model conversation or log.

Create a mode-0600 JSON configuration outside published bundles:

```json
{
  "schema_version": 1,
  "origin": "http://localhost:7422",
  "active_profile_handle": "current",
  "operator": {
    "principal": "local-operator",
    "password_file": "/absolute/path/to/management-password",
    "allowed_profiles": ["current"]
  },
  "profiles": {
    "current": {
      "label": "Current DSH profile",
      "home": "/absolute/path/to/client/.agent-mail",
      "allowed_hub_urls": ["https://hub.example"],
      "ca_file": "/absolute/path/to/hub-ca.pem"
    }
  }
}
```

Omit `ca_file` when the Hub uses a certificate already trusted by the provider.
The origin must exactly match the browser-visible origin, including its port;
it is not inferred from `Host`, forwarding headers or browser input. HTTP is
limited to loopback origins and peers. For HTTPS, use native TLS at the carrier
or a trusted TLS reverse proxy on the same host; a remote cleartext peer is
rejected. A tunnel or desktop port forward may change the browser-visible
origin and requires the corresponding explicit configuration.

The registry resolves homes and target allowlists on the provider host, not on
the browser's machine. `allowed_profiles` is an explicit grant to the configured
principal. Browser requests cannot add grants or supply home/CA/password paths.
Only `active_profile_handle` is associated with the MCP child currently mounted
in this DSH context; other registered targets cannot claim activation through it.

## DSH mounting

Install the reviewed provider artifact outside the UI package and add a private
DSH patch loading its host module. Use the actual installed absolute module
path in your private profile:

```yaml
- insert:
    - id: agent-mail-management
      name: /absolute/path/to/installed-agent-mail/dist/dsh-management.js
      config:
        configFile: /absolute/path/to/management.json
```

The equivalent package export is `agent-mail/dsh-management` if the provider
package is installed in the selected profile's module resolution scope. This
module is opt-in; it is not automatically inserted by the public UI bundle.
Do not load two management instances into the same web carrier.

Mount the ordinary Agent Mail MCP child and UI as usual. The management module
registers only `/v1/management-session/` and `/v1/connection-management/`; it
adds no model-callable tools. The host owns login sessions, CSRF verification
and profile permissions. DSH's ordinary Host/Origin fence remains a separate
check and is never treated as a logged-in identity.

## Login and activation

Sessions use short-lived, opaque HttpOnly cookies with SameSite=Strict; HTTPS
origins also use Secure. CSRF tokens live only in page memory and are checked
on each management mutation. Logout, expiry and host restart invalidate the
session. The principal is fixed by the private configuration, not a form field.

The wizard selects an approved target, verifies TLS, redeems a new-identity
pairing code and requires identity confirmation before saving. A saved file
is reported separately from the effective MCP route. If the child still uses
the earlier Hub environment, update that private profile configuration and
restart it explicitly. The module does not execute arbitrary restart commands.

Activation calls the actual DSH-mounted `comm_diagnose` and `comm_list_agents`
tools. It checks remote HTTPS routing, identity, token-file credential source
and the opaque saved configuration revision. Older providers without this
proof stay unverified. An absent or failing directory response cannot establish
activation, and no check establishes recipient presence or wakes a model.

Only non-sensitive recovery handles and revision/request identifiers may be
retained for page/session recovery. After a host restart, log in again and
reconcile the existing enrollment instead of consuming another code. Closing
a page or clearing its recovery metadata does not cancel an enrollment.

See [guarded enrollment](enrollment.md) for cancellation, expiry, recovery,
backup and the shared lock's five-minute stale-lease limitation. Preserve the
previous connection and its credential until the new running process has been
accepted; restoration remains a separate revision-checked provider operation.
