# Examples

Extension snippets you can copy to `~/.pi/agent/extensions/` and adapt. Each file is self-contained.

- `bash-background.ts`: overrides the bash tool so a running command can move to pi-processes with a shortcut, a timeout, or after an idle period. Requires a pi-processes version that provides the `processes:command:adopt` channel.
- `bash-to-process.ts`: intercepts bash calls that use `&`, `nohup`, `setsid`, or `disown`, and starts them as managed processes instead of blocking them outright.
- `bash-notify-background.ts`: overrides the bash tool so a command that hits its timeout is handed to pi-processes and keeps running in the background instead of being killed.
- `tail-free-starts.ts`: intercepts `process` start calls that wrap the command in `2>&1 | tail -N`, rewrites them to run bare, and appends the tail of the merged log (plus the log paths) to the start result and exit notification. Requires `@aliou/sh`.
