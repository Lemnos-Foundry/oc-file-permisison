# Session folder permissions

A local plugin for temporary external-folder approvals, tested with the OpenCode V2.0.21 terminal and V2.0.22 server. It adds a terminal action without changing OpenCode's built-in permission choices.

## Use

When an external-folder permission request appears, press **Ctrl+Alt+A** or select **Allow external folder for this session** in the command palette. Review the folder and confirm. If several requests are pending, choose one first.

The action is also available as `/allow-session` when the prompt is accessible. The shortcut works while a permission request is blocking the prompt.

The grant covers the displayed folder and its subfolders in the current conversation, including its subagents. Different conversations get no access from that grant. Read, edit, shell and other permissions still apply.

To revoke early, select **Revoke this session's temporary folder permissions** in the command palette or run `/revoke-session-folders`.

## Lifetime

- Normal terminal shutdown runs cleanup and removes that terminal's grants.
- A crash, forced kill, lost connection, or suspended terminal stops the heartbeat. Grants expire 12 seconds after the last successful heartbeat, even though OpenCode's background service remains running.
- Heartbeats run every 3 seconds. Expired grants are never restored automatically.
- Reopening a conversation after the granting terminal closes requires approval again.
- Server restart or plugin reload also clears grants. Reapprove rather than replaying stale approvals.

All grants are in memory. The plugin uses `decision: "once"` for the pending request and a permission-evaluation hook for subsequent requests. It never writes project approvals, session permission rules, or plugin storage.

Existing configured permissions and saved project approvals remain unchanged. A previously saved **Allow always** approval can still allow a folder without prompting. Remove such approvals separately if you want to replace them with temporary access.

If two terminals open the same conversation, they share the server's execution of that conversation. A grant remains valid while its granting terminal is alive. Closing another terminal does not revoke it. Manual revocation removes only grants created by the current terminal.

This controls future OpenCode permission checks, not host filesystem access. Revocation does not stop a tool that already started, undo edits, or remove file contents already in the conversation. Shell directory detection remains best effort, as in OpenCode itself.

## Installation

The package has server and terminal entrypoints. Install it from the package registry:

```sh
opencode plugin add opencode-session-folder-permissions
```

Or configure a local directory in global `opencode.json` under `plugins` and in `cli.json` under `plugins`:

```json
{
  "plugins": ["./local-plugins/session-folder-permissions"]
}
```

A Git checkout works too, for example `opencode plugin add github:kibelenny/opencode-session-folder-permissions`.

The terminal entrypoint belongs in `cli.json`; the server entrypoint belongs in `opencode.json`. Keep all other plugin entries. For remote use, install the server plugin on that server and keep the terminal plugin installed locally.

Restart the terminal after installation. Already-loaded locations may need a service restart to discover the new plugin. When no sessions are running, use `opencode service restart`, then reopen the terminal.

## Tests

```sh
npm test
```

Manual server and terminal integration tests accept a disposable directory as their argument:

```sh
node test/integration.js /path/to/disposable-project
python3 test/tui-integration.py /path/to/disposable-project
```

These create and remove their own empty test conversations. They do not submit prompts or invoke a model. The terminal test runs OpenCode in a pseudo-terminal, approves a synthetic folder request, waits past the lease timeout, and verifies revocation on normal exit.

## License

MIT. See [LICENSE](./LICENSE).
