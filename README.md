# dsh-easy-exit

English | [中文](docs/README.zh.md)

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

Once the server is down the plugin asks the browser to close the tab, so a successful exit usually takes the tab
with it.

That request is best-effort by browser policy: `window.close()` is honoured only for a window the page itself
opened, and a tab opened from a shell or by the user is silently refused - no exception, no return value. So the
button also switches to "The server has stopped. This page can be closed."; if the tab is still there, that note is
why. To start the server again, run the desktop launcher (`启动 DeepSeek Harness.cmd`).

### 2. Running jobs stop the exit

While background jobs are still working the exit is **refused**, and the reply names them:

```
1 job is still working: long build (running). Stopping the server now would kill
that work. Wait for it to finish, or ask again with force to stop anyway.
```

This is the point of the guard: a shutdown takes every running job with it, and losing a build or a test run to a
mis-click is worse than not having a button. Waiting is the default; `force` — an explicit second gesture — is the
only way to discard that work.

### 3. The `/exit` slash command

Typing `/exit` opens the command popup with one row, "Shut down the dsh web server". Picking it raises the shared
popup shell's own risk gate (`Shut down dsh web?`) instead of exiting immediately, so the destructive step always
takes a second, deliberate gesture. The running-job guard applies here too.

This seat is optional: it registers only when the client command surface is available. The header button never
depends on it.

### 4. The agent tool

The host half registers `shutdown_dsh_web`, so you can simply ask:

> 关掉 dsh web / 退出 DeepSeek Harness / stop the server

| parameter | type | default | meaning |
|---|---|---|---|
| `force` | boolean | `false` | stop even though jobs are still running, and use the force-exit path with a non-zero exit code |

Without `force` the tool refuses while jobs run and reports which ones, so an agent cannot discard running work by
accident; with it, the same second gesture the button needs. The tool schedules the exit **after** its result is
returned (a 250 ms delay), so the answer is not truncated by the process stopping mid-response.

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
| `verify-client.mjs` | live test: the served combo carries OUR register call (see the trap below) |

The client half must be a **classic script** loaded through `window.__ModuleLoader__.load({ id, factory })` — no
`import`/`export`, and `require` resolves only against the shell's frozen module table (React, Cordis, static UI
libraries). It registers into the session-scoped `conversation.session.header.utilities` slot, whose occupants
receive no owner props — hence the translate function arrives through the register inject factory.

**Trap when checking a served bundle:** a browser row's combo script concatenates *every* plugin of that row, so a
substring test for a slot name proves nothing. `@linxin666/dsh-remote-web-ui` registers the retired
`sidebar.footer.action` seat, and its literal lands in the same body as ours — an assertion of the form
`body.includes('sidebar.footer.action')` reports `true` for a bundle that does not contain our plugin's code at all.
`verify-client.mjs` therefore anchors on our own registration object (slot name and entry id adjacent) rather than
on any slot name appearing anywhere in the body.

## Install

```sh
dsh plugin --profile web add dsh-easy-exit
```

Restart `dsh web` afterwards: the host half mounts immediately, but the browser bundle is resolved when the package
loads.

> **Git installs are not offered on purpose.** npm 12 ships `allow-git=none`, so
> `npm install github:<owner>/<repo>` fails with `EALLOWGIT: Fetching packages of type "git" have been disabled`.
> Recommending that route would produce a broken install on a stock npm 12 setup. Install from the registry, or use
> a `link:` checkout while developing.

Users on a registry mirror should keep it — `dsh-easy-exit` is a plain public package and installs fine from a
mirror. Only the release itself must go to the registry of record; see [Releasing](#releasing).

## Releasing

Releases go through **[trusted publishing](https://docs.npmjs.com/trusted-publishers)** from GitHub Actions, so no
npm token is stored anywhere and no one-time code is typed:

```sh
npm version patch --no-git-tag-version   # or minor / major
git commit -am "chore: release x.y.z"
git push
# then: Actions -> publish -> Run workflow
```

The [publish workflow](.github/workflows/publish.yml) runs on `workflow_dispatch`; add a tag trigger if you want
releases to start themselves. It needs `id-token: write`, and npm exchanges that OIDC identity for a short-lived
registry credential. `--provenance` records a SLSA provenance statement in the transparency log.

The trusted relationship is configured once per package, and it is an **account-level** action:

```sh
npm login --registry=https://registry.npmjs.org/
npm trust github dsh-easy-exit --file publish.yml --repo <owner>/<repo> --allow-publish
```

That command needs an interactive browser authentication, so run it in a terminal and leave the window open while
you confirm in the browser. Note who this authorises: anyone with write access to the repository can then publish.

Three things cost a debugging session each, so they are recorded here:

- **The workflow must install dependencies.** `npm publish` runs `prepack`, which runs the smoke suite, which imports
  `@deepseek-ai/dsh-tools`; without `npm ci` the publish dies before authentication with `ERR_MODULE_NOT_FOUND`.
- **The workflow must run a recent npm on a recent Node.** The Node 20 image ships npm 10.x, which cannot perform the
  OIDC exchange and reports `ENEEDAUTH` even with `id-token: write` granted; npm 12 additionally requires
  Node `^22.22.2 || ^24.15.0 || >=26`.
- **A successful publish is not instantly downloadable.** npm answers `Your package is being processed and may take a
  few minutes to become available`; the version metadata appeared in about 3 minutes here and the tarball a few
  minutes after that. A 404 right after publishing is not a failure.

A bypass-2FA granular token can still publish directly and is what the 0.1.0 release used, but npm is retiring that
path for direct publishing (targeting January 2027), so it is not the route to build on.

`prepack` runs the test suite, so a failing suite blocks `npm pack` and `npm publish` alike — verified by making the
suite exit non-zero and watching `npm pack` propagate that exit code.

Local publishing also needs the registry of record named explicitly, because a mirror such as
`https://registry.npmmirror.com/` is a read-through cache that rejects publishes and lags behind new releases:

```sh
npm publish --registry=https://registry.npmjs.org/
```

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
npm test                        # 76 host-half assertions, no DSH runtime needed
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
- The running-job guard asks the job registry once per **live session**, because `list(caller)` is session-scoped by
  design and a bare `list()` cannot see session-owned work. A job that no live session owns still shows up, but a
  carrier without a sessions service falls back to unowned jobs only.
- A browser cannot close a tab it did not open, so the button can only report that the server stopped; close the tab
  yourself.
- `inject` deliberately lists only `tools`, so the tool loads in every profile. The HTTP route is mounted through
  `ctx.inject(['webServer','webRuntime'], …)`, which defers until those services exist — a carrier without a web
  server still gets the tool and simply has no button.
- The route lives under its own prefix (`/easy-exit/api`), not on the connection's `/api` channel, so its
  authorization depends on `connection.admit` being reachable; the fallback fence is weaker but never fails open.
