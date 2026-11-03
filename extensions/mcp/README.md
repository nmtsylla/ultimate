Connects the MCP servers in `mcpServers` and lets agents use their tools through one `mcp` tool; the status line shows how many are connected.

## Settings

`mcpServers` takes the same shape as Claude Desktop and Cursor, so a server's config pastes in. Put it in `~/.ultimate/settings.json`, or in a project's `.ultimate/settings.json`:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"]
    },
    "my-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_SERVER_TOKEN}" }
    }
  }
}
```

- **stdio:** `command`, optional `args`, `env` and `cwd` (default: the project root). The server inherits Ultimate's environment plus `env`.
- **Streamable HTTP:** `url` and optional `headers`. The legacy SSE transport is not supported. A server behind OAuth needs only its `url` (see OAuth).
- **Secrets:** `${NAME}` in `args`, `env`, `url` or `headers` is replaced by the secret `NAME` from the Secrets panel (⌘K → Secrets). Never write a token inline. Each such name is declared as a secret, so the Secrets panel lists it, set or missing, with the servers using it. A missing secret fails that server with its name and an Add button; saving it there connects the server again.
- **Precedence:** user and project servers merge by name; a project entry replaces a user entry of the same name. Project servers run commands, so they load only once the project's setup is trusted (`host.projectSettings()` is empty before).
- `"disabled": true` leaves a server out.

Saving either settings file reconnects every server.

## OAuth

An HTTP server behind OAuth needs nothing but its URL: no headers, no token entry. `atlassian` is the whole config:

```json
{ "mcpServers": { "atlassian": { "type": "http", "url": "https://mcp.atlassian.com/v2/mcp" } } }
```

Until someone signs in, the server's first request answers 401 and it waits in **needs login** — it never retries into the same 401. Press **Connect** in the `mcp` chip's popover: Ultimate discovers the authorization server, registers itself there (dynamic client registration, no pre-registered client id), and opens a sign-in page.

**The browser is on the same machine.** Approving ends on a short-lived `127.0.0.1` callback that stores the grant and connects the server: nothing else to do. The port is picked per sign-in; if another process holds the one a previous registration named, the client is registered again with the new redirect URI.

**The browser is on another machine** — Ultimate runs on a host reached over the network (for example Tailscale), so the callback's `127.0.0.1` is the browser's own machine, where nothing listens and the page fails to load. Open the sign-in page from the row's link and approve there; then copy the whole address bar of the page that failed (it holds `code=…&state=…`), paste it into the row's field and press **Finish** or Enter. Ultimate checks `state` against the pending sign-in, exchanges the code and stores the grant exactly as the loopback callback would, then connects the server. Only the code is needed too, if that is all you can copy. An address from another sign-in, or a code that expired or was already used, is refused with the reason and the row stays in **needs login** — press **Connect** for a new sign-in page.

A denied consent, a callback that never arrives (five minutes) or a failed exchange puts the server back into **needs login** with the reason.

- **Where the tokens live:** one file per server URL in `~/.ultimate/mcp-oauth/`, named after a hash of the URL and readable only by its owner (mode 0600), written atomically. They never enter the settings files, logs, transcripts, extension info or the UI. Deleting a file signs that server out.
- **Signing out:** **Log out** in the same popover drops the client registration, tokens, verifier and discovery state, and disconnects the server; the action is `logout {name}`.
- **Refresh:** a stored access token is reused at startup with no prompt. When it expires (or the server rejects it), the transport refreshes it and retries the request once; the popover shows the token's expiry. When the refresh itself is rejected, the grant is dropped and the server waits in **needs login** again.
- **Headers win:** OAuth applies only to an HTTP server that configures no `Authorization` header. A `headers` entry with `Authorization: Bearer ${SECRET}` behaves exactly as before — secret substitution first, no OAuth, no sign-in button — and stdio servers are untouched.

## Tool

`mcp {server}` lists a server's tools with their input schemas; `mcp {server, tool, args}` calls one and returns its text and images. A result the server marks as an error comes back as a tool error. The tool's description names the configured servers, so the prompt changes only when the configuration does, however many tools they have. In codemode, `tools.mcp(...)` runs many calls and filters their results.

Every agent that inherits tools gets `mcp`, and @ultimate lists it in `agents/ultimate.md`. Agents with an explicit `tools` list add it there.

Calls are `replay: 'unsafe'`: a call interrupted by a restart is reported as interrupted, never sent again. A call times out after 10 minutes without progress from the server.

## Lifecycle

Servers connect when the server opens, each on its own: a failing one never blocks another or a turn. A failure or a dropped connection retries after 5 s, doubling up to 5 minutes. The servers close (stdio: the whole process group) when the extension reloads or Ultimate stops. A server's `tools/list_changed` notification refreshes its tool list.

## UI

The status line's `mcp 2/3` chip counts connected out of configured servers, turns red while one failed, turns amber while one waits for a sign-in, and is hidden when none is configured. Its popover lists each server with its transport, source, state or tool count, the error and the next retry, a reconnect button, and for an OAuth server **needs login** with a Connect button, the sign-in page plus the paste field while the browser waits, or `signed in · token expires 21:45` with a Log out button. The Extensions panel's `mcp` row lists the same servers when opened.

Actions: `status` → every server's state; `reconnect {name}` → connects one again and returns the states; `login {name}` → starts the browser sign-in and returns the states, with `loginUrl` on the row while it waits; `completeLogin {name, url}` → completes that waiting sign-in from the address bar of the page a remote browser failed to load (or a bare code) and returns the states; `logout {name}` → drops that server's OAuth credentials, disconnects it and returns the states.
