# Local wake bridges on macOS

These user LaunchAgent templates run one Agent Mail bridge per recipient in the same project. Codex receives as `codex@local` and Antigravity receives as `antigravity@local`.

## Prepare the project

Add the directories containing Node, `codex`, and `agy` to your shell PATH. Sign in to both clients and complete their normal project and MCP trust setup. Generate the shared home and both MCP configurations with quickstart.

```bash
project=/absolute/path/to/project
agent-mail quickstart --path "$project" --runners codex,antigravity
agent-mail doctor --path "$project" --runners codex,antigravity
agy plugin validate --strict "$project/.agents/plugins/agent-mail"
```

From the prepared project, queue a read task in each direction and inspect the plans.

```bash
agent-mail send --path "$project" --as codex@local --to antigravity@local \
  --type task --effect read --body "Summarize this project's README."
agent-mail send --path "$project" --as antigravity@local --to codex@local \
  --type task --effect read --body "Summarize this project's README."
agent-mail bridge --path "$project" --recipient antigravity@local --runner antigravity --dry-run
agent-mail bridge --path "$project" --recipient codex@local --runner codex --dry-run
```

A single bridge invocation polls once. `--ticks N` bounds the number of polls and `--forever` continues until interrupted or a wake fails. `--interval-ms` defaults to 2000. The loop emits a JSON line per nonempty poll and a summary on exit. Dry-run leaves the inbox and cursors untouched, so repeated dry-run ticks can report the same work.

## Keep receipts available to the desktop session

Add `<string>--tasks-only</string>` to `ProgramArguments` on the bridge for the identity you use as the interactive controller. That bridge advances its outbox cursor for `done` and `error` receipts and leaves the inbox delivery untouched for the desktop session to read and acknowledge. The other bridge can continue to process receipts automatically.

Add `<string>--notify</string>` to enable macOS notifications for approval waits, completed wakes, and wake failures. Notifications contain only the recipient, message and task IDs, action, business state, and failure class. They are best effort and suppressed during dry runs.

## Review approvals in the terminal

Run `agent-mail tui --path "$project"` and press `3` for **Approvals**. Use the arrow keys or `j` / `k` to select a pending request. Press `a`, type the complete approval ID, and press Enter to approve. Press `x` to reject the selected pending request. The tab shows approval metadata and leaves the bridge cursors alone.

## Install the LaunchAgents

Copy the two plists to `~/Library/LaunchAgents/`. Edit each copy to set the absolute paths for Node, Agent Mail's built `dist/cli.js`, the project, and the corresponding runner. The project logs directory is created by quickstart. `launchd` uses the PATH in the plist independently of your shell startup files. The Antigravity executable commonly lives at `~/.gemini/bin/agy`. Use its absolute path in the plist.

Bootstrapping starts live polling immediately and queued tasks can consume provider quota. Run the dry runs first and enable the services when ready for live execution.

```bash
agents="$HOME/Library/LaunchAgents"
mkdir -p "$agents"
# Copy and edit the plists before running the following commands.
plutil -lint "$agents/org.agent-mail.bridge.codex.plist" "$agents/org.agent-mail.bridge.antigravity.plist"
examples/launchd/bridge-ctl.sh --path "$project" start
examples/launchd/bridge-ctl.sh --path "$project" status
```

Both templates start in read mode. Automatic workspace edits require both an approved Agent Mail write task and `--allow-write` on the receiving bridge. An approved write at the head of the queue stops a bridge that lacks that flag and leaves its cursor in place. A runner or post-run verification failure also stops the loop so it cannot repeatedly spend quota on the same event.

## Operate the bridges

`bridge-ctl.sh status` shows the installed services' state and last exit code, pending approvals, and recent redacted Agent Mail errors. Use `AGENT_MAIL_BIN=/absolute/path/to/agent-mail` if the CLI is outside PATH. When run from a built checkout, the script can also use the local CLI with Node on PATH.

After resolving a wake error, use `kickstart` to restart a loaded service that exited. `kickstart` defaults to both runners, and `start` loads missing services. Both leave running bridges in place. `stop` unloads both services.

```bash
examples/launchd/bridge-ctl.sh --path "$project" kickstart codex
examples/launchd/bridge-ctl.sh --path "$project" kickstart all
examples/launchd/bridge-ctl.sh --path "$project" stop
```

The script operates on the two template labels in the current user's GUI domain and checks the configured project before taking action. Use distinct labels and file names with `launchctl` directly if you supervise several projects. The project logs `.agent-mail/logs/bridge-*.stderr.log` and `.agent-mail/logs/bridge-*.stdout.log` provide per-runner diagnostics.
