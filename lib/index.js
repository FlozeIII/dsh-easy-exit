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
 * Refuses while jobs are still working: stopping the server takes them with it,
 * and a shutdown that silently kills a running build or test is worse than no
 * shutdown button at all. `force` overrides and reports what it costs.
 *
 * @param ctx - the plugin context, consulted for jobs and the exit request.
 * @param force - whether to escalate past the job guard and the force-exit path.
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

  const busy = activeJobs(ctx)
  if (busy.length > 0 && !force) {
    const names = busy.map(job => `${job.label || job.id} (${job.status})`).join(', ')
    return {
      route: 'blocked',
      jobs: busy,
      message:
        `${busy.length} job${busy.length === 1 ? ' is' : 's are'} still working: ${names}. ` +
        'Stopping the server now would kill that work. Wait for it to finish, or ask again with force to stop anyway.',
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
 * `tools` carries the agent tool; `jobs` carries the guard that refuses to stop
 * the server while work is still running, and `sessions` is what makes that
 * guard process-wide (the registry can only be asked per session). All three are
 * base-profile services, so the tool loads everywhere; the HTTP route the
 * browser button calls is mounted separately, and only once its services exist —
 * see `apply`.
 */
export const inject = ['tools', 'jobs', 'sessions']

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
export function rejectionFor(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
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

/** Statuses that mean a job is still doing work. */
const ACTIVE_JOB_STATUSES = new Set(['running', 'stopping'])

/**
 * Read the job registry, tolerating a context without one.
 *
 * @param ctx - the plugin context.
 * @returns The registry, or undefined when the carrier has no jobs service.
 */
function readJobs(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    // A throwing lookup is treated as "no registry".
  }
  return ctx.jobs
}

/**
 * Read the session store, tolerating a context without one.
 *
 * @param ctx - the plugin context.
 * @returns The store, or undefined when the carrier has no sessions service.
 */
function readSessions(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    // A throwing lookup is treated as "no store".
  }
  return ctx.sessions
}

/**
 * List every session id the store knows about.
 *
 * @param ctx - the plugin context.
 * @returns The ids, or an empty list when they cannot be read.
 */
function sessionIds(ctx) {
  const sessions = readSessions(ctx)
  if (sessions === undefined || typeof sessions.list !== 'function') return []
  try {
    return sessions.list()
      .map(session => session?.id ?? session?.sessionId)
      .filter(id => id !== undefined)
  } catch {
    return []
  }
}

/**
 * List the jobs that are still working, across the whole process.
 *
 * The registry scopes `list(caller)` to caller-owned and unowned jobs, so a
 * bare `list()` sees nothing that a session owns — the guard would silently
 * pass while a background job was still running. Each known session is
 * therefore asked in turn, which is a stateless read rather than a second copy
 * of registry state.
 *
 * Stopping a server takes its running jobs with it, so this is what the exit
 * refuses to do silently.
 *
 * @param ctx - the plugin context.
 * @returns One `{ id, kind, label, status }` entry per active job.
 */
export function activeJobs(ctx) {
  const jobs = readJobs(ctx)
  if (jobs === undefined || typeof jobs.list !== 'function') return []
  try {
    const seen = new Map()
    for (const job of jobs.list()) {
      if (ACTIVE_JOB_STATUSES.has(job?.status)) seen.set(job.id, job)
    }
    for (const sessionId of sessionIds(ctx)) {
      for (const job of jobs.list(sessionId)) {
        if (ACTIVE_JOB_STATUSES.has(job?.status)) seen.set(job.id, job)
      }
    }
    return [...seen.values()].map(job => ({ id: job.id, kind: job.kind, label: job.label, status: job.status }))
  } catch {
    // A registry that throws must not block the exit path with an error.
    return []
  }
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
      'disposal hangs). While background jobs are still running the tool refuses and reports them, because stopping ' +
      'the server kills that work; pass force only after the user accepts losing it. Because the process stops, this ' +
      'tool ends the session too — do not call it for any other purpose. To start the server again, use the desktop ' +
      'launcher.',
    parameters: {
      force: {
        type: 'boolean',
        description:
          'Stop even though jobs are still running, and use the force-exit path with a non-zero code. Defaults to ' +
          'false; never set it without the user accepting that running work is lost.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    execute: async (args) => {
      const result = requestExit(ctx, args?.force === true)
      return {
        ok: result.route !== 'blocked',
        route: result.route,
        message: result.message,
        ...(result.jobs === undefined ? {} : { jobs: result.jobs }),
      }
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
        // instead of a dropped socket. 409 covers both "already shutting down"
        // and "refused while jobs run"; the body says which.
        writeJson(res, result.route === 'appExit' || result.route === 'signal' ? 200 : 409, {
          ok: result.route !== 'duplicate' && result.route !== 'blocked',
          route: result.route,
          message: result.message,
          ...(result.jobs === undefined ? {} : { jobs: result.jobs }),
        })
      },
    }), 'easy-exit: shutdown route')
  })
}
