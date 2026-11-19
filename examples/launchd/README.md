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

## Install the LaunchAgents

Copy the two plists to `~/Library/LaunchAgents/`. Edit each copy to set the absolute paths for Node, Agent Mail's built `dist/cli.js`, the project, and the corresponding runner. The project logs directory is created by quickstart. `launchd` uses the PATH in the plist independently of your shell startup files. The Antigravity executable commonly lives at `~/.gemini/bin/agy`. Use its absolute path in the plist.

Bootstrapping starts live polling immediately and queued tasks can consume provider quota. Run the dry runs first and enable the services when ready for live execution.

```bash
domain="gui/$(id -u)"
agents="$HOME/Library/LaunchAgents"
mkdir -p "$agents"
# Copy and edit the plists before running the following commands.
plutil -lint "$agents/org.agent-mail.bridge.codex.plist" "$agents/org.agent-mail.bridge.antigravity.plist"
launchctl bootstrap "$domain" "$agents/org.agent-mail.bridge.codex.plist"
launchctl bootstrap "$domain" "$agents/org.agent-mail.bridge.antigravity.plist"
launchctl print "$domain/org.agent-mail.bridge.codex"
launchctl print "$domain/org.agent-mail.bridge.antigravity"
```

Both templates start in read mode. Automatic workspace edits require both an approved Agent Mail write task and `--allow-write` on the receiving bridge. An approved write at the head of the queue stops a bridge that lacks that flag and leaves its cursor in place. A runner or post-run verification failure also stops the loop so it cannot repeatedly spend quota on the same event. After resolving the failure, use `launchctl kickstart "$domain/org.agent-mail.bridge.codex"` or the corresponding Antigravity label. Check `.agent-mail/logs/bridge-*.stderr.log`, `.agent-mail/logs/bridge-*.stdout.log` and `agent-mail logs --path "$project"` for details.

Unload either service with `launchctl bootout "$domain/org.agent-mail.bridge.codex"` or the corresponding Antigravity label. If you supervise several projects, use distinct plist labels and file names for each project while retaining the project-specific home and logs paths.
