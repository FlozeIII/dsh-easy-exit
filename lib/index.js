/**
 * dsh-easy-exit — shut the `dsh web` server down conveniently.
 *
 * Host half. It offers two entry points onto one shutdown path:
 *
 *  - the `shutdown_dsh_web` agent tool, so "退出/关掉服务" in a conversation works;
 *  - `POST /easy-exit/api/shutdown`, so the browser button has something to call.
 *
 * Both end in `ctx.appExit(code)` — the launcher's own bounded shutdown path,
 * provided before the tree mounts and wired to `shutdown.shutdown(code)`:
 * dispose the Cordis tree, then exit with the requested code, with a 5 s
 * force-exit ceiling. That is the graceful path (what `Ctrl+C` reaches through
 * the interrupt variant), so sessions and stored state survive; only the
 * process stops.
 *
 * The exit is always deferred by {@link EXIT_DELAY_MS}. `ctx.appExit` disposes
 * the tree synchronously, so calling it inline would destroy the response (and
 * the tool result) before either reaches its reader.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Tool name the model sees. */
export const TOOL_NAME = 'shutdown_dsh_web'

/** Route the browser button posts to. */
export const API_PATH = '/easy-exit/api'

/**
 * Grace given to the caller's response and the tool result before the process
 * leaves. Long enough for the HTTP response to flush and the transcript to
 * record the tool result; short enough that tree disposal starts before the
 * next model request.
 */
const EXIT_DELAY_MS = 250

/** Set once an exit has been scheduled, so repeat calls cannot stack timers. */
let exitScheduled = false

/** Test hook: clears the duplicate-request guard between cases. */
export function __resetExitSchedule() {
  exitScheduled = false
}

/**
 * Read the launcher's exit request, tolerating a context that exposes neither
 * a working `get` nor the property directly.
 *
 * @param ctx - the plugin context.
 * @returns The exit request, or undefined when the launcher provided none.
 */
function readAppExit(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('appExit') : undefined
    if (typeof viaGet === 'function') return viaGet
  } catch {
    // A context whose service lookup throws is treated as one without appExit.
  }
  return typeof ctx.appExit === 'function' ? ctx.appExit : undefined
}

/**
 * Ask the launcher to stop the process after the current response is delivered.
 *
 * @param ctx - the plugin context, consulted for the launcher's exit request.
 * @param force - whether to escalate to the force-exit path.
 * @returns A machine-readable route plus the human-readable account to report.
 */
export function requestExit(ctx, force = false) {
  const code = force ? 1 : 0
  const appExit = readAppExit(ctx)

  if (exitScheduled) {
    return {
      route: 'duplicate',
      message: 'A shutdown is already in progress for this process; nothing further was requested.',
    }
  }
  exitScheduled = true

  setTimeout(() => {
    try {
      if (typeof appExit === 'function') appExit(code)
      else process.kill(process.pid, 'SIGINT')
    } catch {
      // Last resort when neither the launcher request nor the signal works.
      process.exit(code)
    }
  }, EXIT_DELAY_MS)

  if (typeof appExit === 'function') {
    return {
      route: 'appExit',
      message: force
        ? 'Force exit requested through the launcher; the process will stop within a few seconds.'
        : 'Graceful shutdown requested through the launcher; the process will stop within a few seconds. Sessions and state are preserved.',
    }
  }

  return {
    route: 'signal',
    message:
      'The launcher exit request was not available on this context, so a SIGINT will be sent to this process instead ' +
      '(the launcher maps it to the same bounded shutdown). The process will stop within a few seconds.',
  }
}

/**
 * Whether a request may drive a host action.
 *
 * This is the same loopback / same-origin fence the connection layer applies to
 * its own routes, restated here because a raw web-server route owns its own
 * admission: `Host` must be loopback, a cross-site fetch is refused, and an
 * `Origin` that is present must match the requested authority.
 *
 * @param req - the incoming request.
 * @param trustedHosts - extra authorities the profile accepts.
 * @returns True when the request is a same-origin loopback call.
 */
export function isTrustedApiRequest(req, trustedHosts = []) {
  const host = String(req.headers.host ?? '')
  const bare = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const loopback = bare === 'localhost' || bare === '::1' || bare === '127.0.0.1' || /^127\./.test(bare)
  const trusted = trustedHosts.some(entry => String(entry).replace(/:\d+$/, '') === bare)
  if (!loopback && !trusted) return false

  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false

  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'null') {
    try {
      if (new URL(String(origin)).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Send one JSON body.
 *
 * @param res - the response to own.
 * @param status - the HTTP status.
 * @param body - the JSON-serializable payload.
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Read a request body as text.
 *
 * @param req - the incoming request.
 * @returns The decoded body, or an empty string.
 */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export const name = 'dsh-easy-exit'

/**
 * Only the tool registry is required, so the agent tool loads in every profile
 * (including carriers with no web server). The HTTP route the browser button
 * calls is mounted separately, and only once its services exist — see `apply`.
 */
export const inject = ['tools']

/**
 * Decide whether a request may drive the shutdown.
 *
 * `connection.admit` is the connection layer's own browser-trust and
 * authentication gate — the same one its RPC and Fetch routes use, so the
 * random per-process `dsh-auth-…` session cookie is verified by its owner
 * instead of being reimplemented here. It is preferred whenever the service is
 * mounted; the local fence is only a fallback for a carrier without it.
 *
 * @param ctx - the plugin context.
 * @param req - the incoming request.
 * @returns The rejection status, or undefined when the request may proceed.
 */
export function rejectionFor(ctx, req) {  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  if (connection !== undefined && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit({ headers: req.headers })
      if (admission !== undefined && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // Fall through to the local fence rather than failing open.
    }
  }
  return isTrustedApiRequest(req, ctx.webRuntime?.trustedHosts ?? []) ? undefined : 403
}

/**
 * Register the agent tool and the HTTP route.
 *
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Shut down the `dsh web` server process this session runs in. Use when the user asks to exit, quit, stop, ' +
      'close or restart DeepSeek Harness, or to stop the server. The shutdown is graceful: the Cordis tree disposes ' +
      'first, sessions and stored state are preserved, and the process then exits (a 5 s ceiling forces exit if ' +
      'disposal hangs). Because the process stops, this tool ends the session too — do not call it for any other ' +
      'purpose. To start the server again, use the desktop launcher.',
    parameters: {
      force: {
        type: 'boolean',
        description:
          'Escalate to the force-exit path with a non-zero code. Defaults to false; use only when a graceful ' +
          'shutdown is known to hang.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: async (args) => {
      const result = requestExit(ctx, args?.force === true)
      return { ok: true, route: result.route, message: result.message }
    },
  }))

  // The route needs the web server; a carrier without one still gets the tool.
  // `ctx.inject` starts a child fiber that loads only once these services
  // exist, so the plugin never blocks activation on a service a profile lacks.
  ctx.inject(['webServer', 'webRuntime'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const rejection = rejectionFor(webCtx, req)
        if (rejection !== undefined) {
          writeJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        let force = false
        try {
          const body = await readBody(req)
          if (body.trim().length > 0) force = JSON.parse(body)?.force === true
        } catch {
          force = false
        }

        const result = requestExit(ctx, force)
        // Answer before the tree disposes, so the browser sees a clean reply
        // instead of a dropped socket.
        writeJson(res, result.route === 'duplicate' ? 409 : 200, {
          ok: result.route !== 'duplicate',
          route: result.route,
          message: result.message,
        })
      },
    }), 'easy-exit: shutdown route')
  })
}
