# dsh-easy-exit

Conveniently shut down the `dsh web` server: a **conversation-header exit button** and an **agent tool**, both
wired to the launcher's own bounded shutdown path.

> **Capability notice.** This plugin can stop the `dsh web` process — that is its entire purpose. The shutdown is
> graceful (the Cordis tree disposes first, sessions and stored state are preserved) and the route is gated by the
> connection layer's own authentication, but installing it grants a browser button and an agent tool the ability to
> end the server. Read the source before installing anything that runs with your credentials.

## Why this exists

Stopping `dsh web` otherwise means finding the console window the server runs in and pressing `Ctrl+C`, or killing
the process by PID. This plugin puts the exit where you already are: the browser.

It also fills a documentation gap: `ctx.appExit` is the only plugin-facing way to request a graceful exit, and it is
described only in passing in the `dsh-cmdline` package README. The two traps below are easy to hit and hard to
diagnose, so they are stated here explicitly:

- calling `ctx.appExit` synchronously inside a tool destroys the tool result (the tree disposes first) — the exit
  must be deferred;
- a tool registered with a raw `parameters` object is rejected by the provider
  (`Invalid schema … got 'type: null'`) — the spec must be compiled through `defineTool`.


## How to use it

### 1. The header button

A power button (⏻) sits in the **conversation header's utilities seat** — on the right side of the session title
bar, beside the shipped actions. It is visible on every session and needs neither a sidebar expansion nor the right
sidebar.

- **First click** arms it: the button turns red and expands to "Confirm exit / 确认退出" for 5 seconds.
- **Second click** within that window shuts the server down; an unanswered first click simply expires.

The two-step confirmation exists because the exit is process-wide: it stops the server for every open tab and every
session.

Once the server is down the page loses its connection — that is the expected outcome. Close the tab. To start the
server again, run the desktop launcher (`启动 DeepSeek Harness.cmd`).

### 2. The `/exit` slash command

Typing `/exit` opens the command popup with one row, "Shut down the dsh web server". Picking it raises the shared
popup shell's own risk gate (`Shut down dsh web?`) instead of exiting immediately, so the destructive step always
takes a second, deliberate gesture.

This seat is optional: it registers only when the client command surface is available. The header button never
depends on it.

### 3. The agent tool

The host half registers `shutdown_dsh_web`, so you can simply ask:

> 关掉 dsh web / 退出 DeepSeek Harness / stop the server

| parameter | type | default | meaning |
|---|---|---|---|
| `force` | boolean | `false` | escalate to the force-exit path with a non-zero exit code |

The tool schedules the exit **after** its result is returned (a 250 ms delay), so the answer is not truncated by the
process stopping mid-response.

## How the shutdown works

The plugin never kills the process itself. It calls **`ctx.appExit(code)`** — the exit request the CLI installs on
the context before the plugin tree mounts, wired to the launcher's shutdown controller
(`@deepseek-ai/dsh-cmdline`, see its `README.md`). That controller:

1. disposes the application tree (the same teardown `Ctrl+C` triggers),
2. exits with the requested code,
3. force-exits after a **5 s ceiling** if disposal hangs.

So sessions, cost ledgers, task-board state and settings are all preserved — only the process stops.

Two documented wrinkles shape the implementation:

- `shutdown.shutdown(code)` sets `process.exitCode` and relies on the event loop draining; the 5 s ceiling is what
  guarantees the process actually leaves. Anything that keeps the loop alive (a stray `setInterval`, for example)
  delays the exit — that is why this plugin adds no such handle.
- The exit is always deferred, because disposing the tree synchronously would destroy the HTTP response (and the
  tool result) before either reaches its reader.

If `ctx.appExit` is absent (a carrier that did not install the CLI exit request), the plugin sends **SIGINT to
itself** instead, which the launcher maps to the same bounded shutdown, and says so in the result rather than
failing silently.

## Authorization

`POST /easy-exit/api` is gated by **`connection.admit`** — the connection layer's own browser-trust and
authentication check, the same one its RPC and Fetch routes use. An unauthenticated request is answered `401` and a
cross-site or non-loopback one `403`, so a local process without the browser's session cookie cannot stop the
server.

Measured behaviour: unauthenticated `POST` → `401`; with the session cookie → `200`
`{"ok":true,"route":"appExit",…}`, server stopped in ~0.5 s.

If the connection service is missing, the plugin falls back to a local loopback / same-origin / `sec-fetch-site`
fence rather than failing open.

## Layout

| file | role |
|---|---|
| `lib/index.js` | host half: registers the tool, mounts the route, requests the exit |
| `lib/client.js` | client half: the header button and the /exit command (a classic-script factory body, not an ES module) |
| `cordis.patch.yml` | bundle patch: inserts the `easy-exit` loader row |
| `smoke.mjs` | host-half tests, no DSH runtime needed |
| `e2e.mjs` | live test: token exchange → authenticated POST → server actually stopping |
| `verify-client.mjs` | live test: the client bundle is served and carries the register call |

The client half must be a **classic script** loaded through `window.__ModuleLoader__.load({ id, factory })` — no
`import`/`export`, and `require` resolves only against the shell's frozen module table (React, Cordis, static UI
libraries). It registers into the session-scoped `conversation.session.header.utilities` slot, whose occupants receive\nno owner props — hence the translate function arrives through the register inject factory.

## Install (development)

This package is plain ESM with no build step.

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add "link:D:\dev\dsh-easy-exit"
# or, through the CLI:
dsh plugin --profile web add "link:D:\dev\dsh-easy-exit"
```

A `link:` install symlinks the package (`dsh plugin` writes both the dependency and the bundle entry), so edits
under `lib/` need no reinstall.

**The host half reloads live; the client half does not.** A profile with `patchReload: live` picks up host-side edits
at once — the `shutdown_dsh_web` tool can appear in an already-running session. The browser bundle is resolved at
package load, so the button needs a **restart of `dsh web`** (then a page refresh) before it appears.

## Verify

The suite is self-contained: `@deepseek-ai/dsh-tools` is a pinned devDependency (the host supplies it at runtime, so
it is a `peerDependency` for consumers and a `devDependency` here).

```powershell
npm ci
npm test                        # 52 host-half assertions, no DSH runtime needed
```

`npm test` runs on every push through the [test workflow](.github/workflows/test.yml).

Live checks need a throwaway instance — never the one you are using:

```powershell
$env:DSH_WEB_PORT = "3099"; dsh web --port 3099 --no-open   # in another window
# then copy the ?token=… value from its output:
node e2e.mjs 3099 "<token>"             # 401 unauth, 200 authed, server stops
node verify-client.mjs 3099 "<token>"   # the client bundle carries the registration
```

`smoke.mjs` covers the exit paths (graceful, force, signal fallback, duplicate refusal), the compiled tool schema,
the admission gate, the trust fence, and the route's status codes.

## Limitations

- The exit is **process-wide**: it stops the server for every open browser tab and every session, not just yours.
- A browser cannot close a tab it did not open, so the button can only report that the server stopped; close the tab
  yourself.
- `inject` deliberately lists only `tools`, so the tool loads in every profile. The HTTP route is mounted through
  `ctx.inject(['webServer','webRuntime'], …)`, which defers until those services exist — a carrier without a web
  server still gets the tool and simply has no button.
- The route lives under its own prefix (`/easy-exit/api`), not on the connection's `/api` channel, so its
  authorization depends on `connection.admit` being reachable; the fallback fence is weaker but never fails open.
