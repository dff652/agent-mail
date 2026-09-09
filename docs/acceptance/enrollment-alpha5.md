# Guarded enrollment alpha.5 local acceptance

Date: 2026-09-09. Candidate: `agent-mail@1.0.0-alpha.5`, based on public
`ca6601c`. This is provider acceptance, not a DSH browser or deployment result.

- `npm run check`: lint, typecheck and build PASS; 38 files, 298 tests PASS.
- `npm run contracts:check`: 12 artifacts, protocol 0.2 PASS.
- Final independent review of backend, exact artifact and documentation: PASS.
- `npm pack --dry-run --ignore-scripts` and actual pack PASS; 113 files.
- Artifact: `agent-mail-1.0.0-alpha.5.tgz`.
- SHA-256: `961bb4e0efc965b11f72a02d30af2211ed350f3f46ea80f4f3bdb7b72f7d78cb`.
- Node 20.19.2; exact tarball installed offline in a clean disposable prefix
  with production dependencies, then executed from installed `dist`.

The installed artifact passed new-identity enrollment against a native TLS Hub,
previous-connection preservation, private credential custody and safe DTOs,
saved/restart-required separation, actual remote MCP route/directory evidence,
an independent recipient's correlated claim/terminal/ack task round trip,
manager/MCP restart and committed-cancel rejection, plus explicit revision-checked
restore retaining the previous credential. Disposable acceptance homes were removed.

Tests include real management HTTP requests with a manager created per request,
lost-response recovery through the original context handle, actual child-process
crashes after selected durable writes, simultaneous identity redemption and
preservation of later independent credentials/roster generations. Independent
fault probes also verified repeated failed-commit rollback, expired custody
cleanup, cancellation after identity mismatch and cross-process commit/cancel
serialization. A final real-API regression also verifies that legacy redemption
waits for the Hub lock without holding SQLite against guarded commit. It fails
on the pre-fix source and passes after unifying the lock order. These are
selected faults, not exhaustive power-loss proof.

The shared lock's five-minute stale lease remains a restart limitation after
hard process failure. Crash tests model expiry by aging the terminated child's
lock metadata. A management embedding still supplies authentication, CSRF,
profile permissions and actual activation evidence; the adapter is not a login
or lifecycle service. The DSH wizard, publication and live upgrade are separate
gates. See [the embedding guide](../guides/enrollment.md).
