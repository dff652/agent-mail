# TypeScript-only public candidate report

## Provenance

- Source commit: `94191e7cf824eb969011e816d050c5d4104919ec`
- Candidate model: a new local repository with one root commit on `main`
- History policy: no source refs, tags, remotes, or inherited Git objects
- Publication state: local candidate only; no push, release, or visibility change performed

## Included

- TypeScript product in `packages/agent-mail`
- language-neutral protocol, schema, settings, MCP, HTTP, lifecycle, policy, and CLI contracts
- Node-only CI and tag-triggered release workflow
- npm release installer, release gate, contract gate, artifact builder, and isolated-install smoke
- curated public README, security, contribution, Hub, MCP, license, and notice material

## Excluded

- Python product sources, tests, packaging metadata, runners, and examples
- `agent-mail-dev` and its Python-backed development MCP runner
- Python interoperability and database round-trip tests
- dual-implementation CI and release paths
- internal candidate builders, workflow assertions, target-soak payloads, and private soak evidence
- legacy, research, archive, roadmap, rewrite, evaluation, and internal migration documentation

## Functional boundaries

- Published commands are `agent-mail` and `agent-mail-mcp` only.
- CI installs and validates the Node.js 20 toolchain only.
- Release output is limited to the npm tarball, CycloneDX SBOM, and `SHA256SUMS`.
- Remote Hub, federation, and wake features remain security-sensitive developer-preview features.
- This directory is not a published release and does not change the visibility of any repository.

## Verification

Commands were run from this candidate unless a package directory is shown.

| Check | Command | Result |
|---|---|---|
| Exact dependencies | `npm --prefix packages/agent-mail ci` | passed |
| Lint | `npm --prefix packages/agent-mail run lint` | passed |
| Typecheck | `npm --prefix packages/agent-mail run typecheck` | passed |
| Build | `npm --prefix packages/agent-mail run build` | passed |
| Full Vitest suite | `npm --prefix packages/agent-mail test` | 29 files, 249 tests passed |
| Post-decoupling targeted tests | `npx vitest run test/cli-verbs-contract.test.ts test/wake.test.ts test/hub-wake.test.ts` | 3 files, 39 tests passed |
| README core lifecycle | execute documented send/inbox/claim/done/ack flags against an isolated store | passed |
| TS-only contracts | `SKIP_NPM_CI=1 bash scripts/run_contracts_ts.sh` | 12 files, 71 tests passed; 12 manifest artifacts validated |
| Release gate | `bash scripts/release_check_ts.sh` | passed; 103-file npm tarball and isolated CLI smoke passed |
| Release artifacts | `bash scripts/build-release-artifacts.sh <empty-temp-dir>` | only tarball, SBOM, and checksums produced and verified |
| Markdown links | local Node link checker over tracked Markdown | 20 files passed |

After the root commit, the candidate is additionally checked for a single reachable commit, no
remotes or tags, no unexpected Python artifacts, high-signal secrets/private markers, and whitespace
errors. Re-run `bash scripts/public_audit.sh` before any publication decision.
