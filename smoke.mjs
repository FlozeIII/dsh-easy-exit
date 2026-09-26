/**
 * Host-half smoke test — no DSH runtime needed.
 *
 * Stubs the services the host half injects (`tools`, `webServer`, `webRuntime`)
 * and drives the real exit path with a recording `appExit`. Also exercises the
 * HTTP route directly: the trust fence, the method guard, and the shutdown
 * request itself.
 *
 * NOTE: `tool.execute(args, ctx)` receives an execution context, NOT the plugin
 * context — the plugin closes over the ctx handed to `apply()`. Tests must
 * therefore wire `appExit` through `apply()`, or they will exercise the signal
 * fallback (which really does SIGINT the running test process).
 *
 * Run: node smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { apply, requestExit, name, TOOL_NAME, API_PATH, isTrustedApiRequest, rejectionFor, __resetExitSchedule, RESTART_EXIT_CODE } from './lib/index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}
const tick = () => new Promise(resolve => setTimeout(resolve, 500))
const fresh = () => __resetExitSchedule()

/**
 * Mount the plugin against stubbed services.
 *
 * @param options - `exitCodeSink` records appExit calls; `trustedHosts` seeds webRuntime.
 * @returns The registered tool, recorded calls, and the registered route.
 */
const mount = (options = {}) => {
  fresh()
  const registered = []
  const calls = []
  const routes = []
  const exit = options.noExit === true ? undefined : code => calls.push(code)
  const connection = options.admit === undefined ? undefined : { admit: options.admit }
  const webRuntime = { trustedHosts: options.trustedHosts ?? [] }
  const webServer = { register: route => { routes.push(route); return () => {} } }
  const jobs = {
    list: caller =>
      options.jobsBySession === undefined
        ? (options.jobs ?? [])
        : (caller === undefined ? [] : (options.jobsBySession[caller] ?? [])),
  }
  const sessions = { list: () => options.sessions ?? [] }
  const ctx = {
    tools: { register: tool => registered.push(tool) },
    webRuntime,
    jobs,
    sessions,
    effect: callback => callback(),
    get: key => {
      if (key === 'appExit') return exit
      if (key === 'connection') return connection
      if (key === 'webRuntime') return webRuntime
      if (key === 'jobs') return options.noJobs === true ? undefined : jobs
      if (key === 'sessions') return options.noSessions === true ? undefined : sessions
      if (key === 'webServer') return options.noWebServer === true ? undefined : webServer
      return undefined
    },
    // The real ctx.inject defers until the named services exist; the stub
    // invokes the body immediately with them, which is what a loaded web
    // profile does.
    inject: (services, callback) => {
      if (options.noWebServer === true) return
      callback({ ...ctx, webServer })
    },
    ...(exit === undefined ? {} : { appExit: exit }),
  }
  apply(ctx)
  return { tool: registered[0], registered, calls, route: routes[0], routes }
}

/** Minimal response double that records status and body. */
const makeRes = () => {
  const state = { status: undefined, body: '' }
  return {
    state,
    writeHead(status) { state.status = status },
    end(text) { state.body = text ?? '' },
  }
}

/** Minimal request double: a loopback POST by default. */
const makeReq = (overrides = {}) => ({
  method: 'POST',
  headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...(overrides.headers ?? {}) },
  async *[Symbol.asyncIterator]() {
    if (overrides.body !== undefined) yield Buffer.from(overrides.body)
  },
  ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'headers' && k !== 'body')),
})

// --- exit request paths -------------------------------------------------------
{
  fresh()
  const calls = []
  const result = requestExit({ appExit: code => calls.push(code) })
  await tick()
  check('appExit path used', result.route === 'appExit', `route=${result.route}`)
  check('graceful code 0 requested', calls.length === 1 && calls[0] === 0, `calls=${JSON.stringify(calls)}`)
  check('result carries instructions', typeof result.message === 'string' && result.message.length > 0)
}

{
  fresh()
  const calls = []
  const result = requestExit({ get: key => (key === 'appExit' ? code => calls.push(code) : undefined) })
  await tick()
  check('ctx.get("appExit") is honoured', result.route === 'appExit', result.route)
  check('ctx.get path requests code 0', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

{
  fresh()
  const signals = []
  const original = process.kill
  process.kill = (pid, sig) => { signals.push([pid, sig]); return true }
  try {
    const result = requestExit({ get: () => { throw new Error('boom') } })
    await tick()
    check('throwing ctx.get falls back to a signal', result.route === 'signal', result.route)
    check('fallback reached the signal path', signals.length === 1 && signals[0][1] === 'SIGINT', JSON.stringify(signals))
  } catch (error) {
    check('throwing ctx.get falls back to a signal', false, `threw ${error?.message}`)
  } finally {
    process.kill = original
  }
}

{
  fresh()
  const calls = []
  requestExit({ appExit: code => calls.push(code) }, { force: true })
  await tick()
  check('force path uses non-zero code', calls.length === 1 && calls[0] === 1, `calls=${JSON.stringify(calls)}`)
}

{
  fresh()
  const calls = []
  const ctx = { appExit: code => calls.push(code) }
  const first = requestExit(ctx)
  const second = requestExit(ctx)
  await tick()
  check('first request schedules the exit', first.route === 'appExit', first.route)
  check('second request is refused', second.route === 'duplicate', second.route)
  check('only one exit was requested', calls.length === 1 && calls[0] === 0, `calls=${JSON.stringify(calls)}`)
}

// --- the running-job guard ----------------------------------------------------
{
  fresh()
  const calls = []
  const jobs = [
    { id: 'bash-1', kind: 'tool-jobs', label: 'npm run build', status: 'running' },
    { id: 'bash-2', kind: 'tool-jobs', label: 'finished thing', status: 'completed' },
  ]
  const result = requestExit({ appExit: code => calls.push(code), jobs: { list: () => jobs } })
  await tick()
  check('a running job blocks the exit', result.route === 'blocked', result.route)
  check('the blocked result names the job', result.jobs?.length === 1 && result.jobs[0].id === 'bash-1', JSON.stringify(result.jobs))
  check('the message mentions the job', String(result.message).includes('npm run build'), String(result.message).slice(0, 80))
  check('a blocked exit requests nothing', calls.length === 0, JSON.stringify(calls))
}

{
  fresh()
  const calls = []
  const jobs = [{ id: 'bash-3', kind: 'tool-jobs', label: 'long task', status: 'stopping' }]
  const result = requestExit({ appExit: code => calls.push(code), jobs: { list: () => jobs } }, { force: true })
  await tick()
  check('force overrides the job guard', result.route === 'appExit', result.route)
  check('force still exits with a non-zero code', calls.length === 1 && calls[0] === 1, JSON.stringify(calls))
}

{
  fresh()
  const calls = []
  // Settled statuses must not block: only running/stopping are work in flight.
  const jobs = [
    { id: 'bash-4', label: 'done', status: 'completed' },
    { id: 'bash-5', label: 'dead', status: 'killed' },
    { id: 'bash-6', label: 'broke', status: 'failed' },
  ]
  const result = requestExit({ appExit: code => calls.push(code), jobs: { list: () => jobs } })
  await tick()
  check('settled jobs do not block the exit', result.route === 'appExit', result.route)
  check('settled jobs still exit gracefully', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

{
  fresh()
  const calls = []
  const result = requestExit({ appExit: code => calls.push(code), jobs: { list: () => { throw new Error('registry down') } } })
  await tick()
  check('a throwing registry does not block the exit', result.route === 'appExit', result.route)
  check('a throwing registry still exits', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

{
  fresh()
  const calls = []
  const result = requestExit({ appExit: code => calls.push(code) })
  await tick()
  check('a context without jobs still exits', result.route === 'appExit', result.route)
  check('no jobs service exits gracefully', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

{
  // Through the route: a blocked shutdown is a 409 that carries the job list.
  const { route, calls } = mount({ jobs: [{ id: 'bash-9', label: 'busy work', status: 'running' }], admit: () => ({ peer: {} }) })
  const res = makeRes()
  await route.handler(makeReq(), res)
  await tick()
  check('route answers 409 while jobs run', res.state.status === 409, `${res.state.status} ${res.state.body}`)
  check('route reports the blocking job', JSON.parse(res.state.body || '{}').jobs?.[0]?.label === 'busy work', res.state.body)
  check('route did not schedule an exit', calls.length === 0, JSON.stringify(calls))
}

{
  // The regression that matters: the registry scopes list(caller) to
  // caller-owned and unowned jobs, so a bare list() sees NOTHING that a session
  // owns. This stub reproduces that exactly — the job is invisible to
  // list() and visible only to list(sessionId) — and the guard must still find
  // it by asking each live session.
  fresh()
  const calls = []
  const SESSION = 'session-abc'
  const ownedJob = { id: 'pwsh-1', kind: 'tool-jobs', label: 'long build', status: 'running', owner: SESSION }
  const ctx = {
    appExit: code => calls.push(code),
    jobs: { list: caller => (caller === SESSION ? [ownedJob] : []) },
    sessions: { list: () => [{ id: SESSION }] },
  }
  const result = requestExit(ctx)
  await tick()
  check('a session-owned job blocks the exit', result.route === 'blocked', `${result.route} ${JSON.stringify(result.jobs)}`)
  check('the session-owned job is named', result.jobs?.[0]?.label === 'long build', JSON.stringify(result.jobs))
  check('the blocked exit requested nothing', calls.length === 0, JSON.stringify(calls))
}

{
  // The same shape reached the route: 409 with the job list, no exit scheduled.
  const SESSION = 'session-xyz'
  const ownedJob = { id: 'pwsh-2', kind: 'tool-jobs', label: 'owned work', status: 'running', owner: SESSION }
  const { tool, calls } = mount({
    admit: () => ({ peer: {} }),
    jobsBySession: { [SESSION]: [ownedJob] },
    sessions: [{ id: SESSION }],
  })
  const value = await tool.execute({})
  await tick()
  check('the tool refuses for a session-owned job', value.route === 'blocked' && value.ok === false, JSON.stringify(value).slice(0, 120))
  check('the tool names the session-owned job', value.jobs?.[0]?.label === 'owned work', JSON.stringify(value.jobs))
  check('the refused tool requested nothing', calls.length === 0, JSON.stringify(calls))
}

{
  // A settled job owned by a session must not block.
  fresh()
  const calls = []
  const SESSION = 'session-done'
  const ctx = {
    appExit: code => calls.push(code),
    jobs: { list: caller => (caller === SESSION ? [{ id: 'pwsh-3', label: 'finished', status: 'completed', owner: SESSION }] : []) },
    sessions: { list: () => [{ id: SESSION }] },
  }
  const result = requestExit(ctx)
  await tick()
  check('a settled session-owned job does not block', result.route === 'appExit', result.route)
  check('a settled session-owned job still exits', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

{
  // A store whose session shape uses sessionId rather than id still works.
  fresh()
  const calls = []
  const SESSION = 'session-alt'
  const ctx = {
    appExit: code => calls.push(code),
    jobs: { list: caller => (caller === SESSION ? [{ id: 'pwsh-4', label: 'alt shape', status: 'running', owner: SESSION }] : []) },
    sessions: { list: () => [{ sessionId: SESSION }] },
  }
  const result = requestExit(ctx)
  await tick()
  check('a sessionId-shaped session is honoured', result.route === 'blocked', result.route)
}

// --- restart ------------------------------------------------------------------
{
  fresh()
  const calls = []
  const result = requestExit({ appExit: code => calls.push(code) }, { restart: true })
  await tick()
  check('a restart uses the restart exit code', calls.length === 1 && calls[0] === RESTART_EXIT_CODE, JSON.stringify(calls))
  check('the restart code is 75 (EX_TEMPFAIL)', RESTART_EXIT_CODE === 75, String(RESTART_EXIT_CODE))
  check('a restart reports the restart route', result.route === 'restart', result.route)
  check('a restart explains the launcher will start it again', /launcher will start it again/.test(String(result.message)), String(result.message).slice(0, 70))
}

{
  fresh()
  const calls = []
  // A plain exit must not be mistaken for a restart.
  const result = requestExit({ appExit: code => calls.push(code) })
  await tick()
  check('a plain exit is not a restart', result.route === 'appExit' && calls[0] === 0, `${result.route} ${JSON.stringify(calls)}`)
}

{
  fresh()
  const calls = []
  // The guard covers restart too: relaunching kills running work just as surely.
  const jobs = [{ id: 'bash-r', label: 'long build', status: 'running' }]
  const result = requestExit({ appExit: code => calls.push(code), jobs: { list: () => jobs } }, { restart: true })
  await tick()
  check('a running job blocks a restart', result.route === 'blocked', result.route)
  check('the blocked restart mentions restarting', /restart/.test(String(result.message)), String(result.message).slice(-60))
  check('a blocked restart requests nothing', calls.length === 0, JSON.stringify(calls))
}

{
  fresh()
  const calls = []
  const jobs = [{ id: 'bash-f', label: 'long build', status: 'running' }]
  const result = requestExit({ appExit: code => calls.push(code), jobs: { list: () => jobs } }, { restart: true, force: true })
  await tick()
  check('force restarts despite running jobs', result.route === 'restart' && calls[0] === RESTART_EXIT_CODE, `${result.route} ${JSON.stringify(calls)}`)
}

{
  // A carrier with no launcher exit request cannot carry the restart code, and
  // the signal fallback must say so rather than promise a relaunch. A SIGINT
  // listener absorbs the fallback so the test process survives long enough to
  // observe it.
  fresh()
  let signalled = false
  const realKill = process.kill
  process.kill = () => { signalled = true; return true }
  const result = requestExit({ get: () => undefined }, { restart: true })
  check('a restart without appExit falls back to a signal', result.route === 'signal', result.route)
  check('the signal fallback admits it cannot restart', /cannot carry the restart request/.test(String(result.message)), String(result.message).slice(0, 80))
  await tick()
  process.kill = realKill
  check('the fallback really sent the signal', signalled === true, String(signalled))
}

{
  // Through the route: a restart is asked for with the query string, which is
  // the carrier-independent signal. Measured, not assumed: the live web carrier
  // ignored a restart flag sent in the request body while honouring the same
  // flag in the query string, so this is the path that must keep working.
  const { route, calls } = mount({ admit: () => ({ peer: {} }) })
  const res = makeRes()
  await route.handler(makeReq({ url: '/easy-exit/api?restart=1' }), res)
  await tick()
  check('route restarts from the query string', res.state.status === 200 && calls[0] === RESTART_EXIT_CODE, `${res.state.status} ${JSON.stringify(calls)}`)
  check('query-string restart reports the restart route', JSON.parse(res.state.body || '{}').route === 'restart', res.state.body)
}

{
  // A lookalike query value must not count as a restart, and a plain request
  // must not either.
  const { route, calls } = mount({ admit: () => ({ peer: {} }) })
  const res = makeRes()
  await route.handler(makeReq({ url: '/easy-exit/api?restart=0' }), res)
  await tick()
  check('restart=0 is not a restart', JSON.parse(res.state.body || '{}').route === 'appExit' && calls[0] === 0, `${res.state.body} ${JSON.stringify(calls)}`)
}

{
  // The body is still honoured when it arrives: `force` rides with it.
  const { route, calls } = mount({ admit: () => ({ peer: {} }) })
  const res = makeRes()
  await route.handler(makeReq({ body: JSON.stringify({ force: true }) }), res)
  await tick()
  check('force still arrives from the body', calls[0] === 1, JSON.stringify(calls))
}

{
  // Through the tool: the restart parameter reaches requestExit.
  const { tool, calls } = mount({ admit: () => ({ peer: {} }) })
  const value = await tool.execute({ restart: true })
  await tick()
  check('the tool restarts with the restart code', calls[0] === RESTART_EXIT_CODE, JSON.stringify(calls))
  check('the tool reports the restart route', value.route === 'restart', JSON.stringify(value).slice(0, 90))
}

// --- registration surface -----------------------------------------------------
{
  const { tool, registered, route } = mount()
  check('plugin name', name === 'dsh-easy-exit', name)
  check('one tool registered', registered.length === 1, `count=${registered.length}`)
  check('tool name', tool?.name === TOOL_NAME && TOOL_NAME === 'shutdown_dsh_web', String(tool?.name))
  // defineTool must compile the per-property spec into a real object-root JSON
  // Schema. Registering the raw spec sends `type: null` and the provider rejects
  // the whole request (INVALID_REQUEST) — that regression is what this guards.
  check('parameters compiled to an object root', tool?.parameters?.type === 'object', JSON.stringify(tool?.parameters?.type))
  check('force is a documented boolean property',
    tool?.parameters?.properties?.force?.type === 'boolean',
    JSON.stringify(tool?.parameters?.properties?.force?.type))
  check('output render present', typeof tool?.output?.render === 'function')
  check('route registered at the expected path', route?.path === API_PATH && API_PATH === '/easy-exit/api', String(route?.path))
  check('route is a prefix route', route?.kind === 'prefix', String(route?.kind))
}

// --- tool execution -----------------------------------------------------------
{
  const { tool, calls } = mount()
  const value = await tool.execute({})
  await tick()
  check('execute requests code 0', calls.length === 1 && calls[0] === 0, `calls=${JSON.stringify(calls)}`)
  check('execute reports the appExit route', value.route === 'appExit', JSON.stringify(value))
}

{
  const { tool, calls } = mount()
  await tool.execute({ force: true })
  await tick()
  check('execute force requests code 1', calls.length === 1 && calls[0] === 1, `calls=${JSON.stringify(calls)}`)
}

// --- a carrier with no web server still gets the tool -------------------------
{
  const { tool, registered, routes } = mount({ noWebServer: true })
  check('tool registers without a web server', registered.length === 1 && tool?.name === TOOL_NAME, String(tool?.name))
  check('no route is mounted without a web server', routes.length === 0, `routes=${routes.length}`)
}

// --- the HTTP route the browser button calls ----------------------------------
{
  const { route, calls } = mount()
  const res = makeRes()
  await route.handler(makeReq(), res)
  await tick()
  check('trusted POST answers 200', res.state.status === 200, `${res.state.status} ${res.state.body}`)
  check('trusted POST body reports ok', JSON.parse(res.state.body || '{}').ok === true, res.state.body)
  check('trusted POST scheduled the exit', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

{
  const { route, calls } = mount()
  const res = makeRes()
  await route.handler(makeReq({ headers: { host: 'evil.example.com' } }), res)
  await tick()
  check('non-loopback POST is refused', res.state.status === 403, `${res.state.status} ${res.state.body}`)
  check('refused POST requested no exit', calls.length === 0, JSON.stringify(calls))
}

{
  const { route, calls } = mount()
  const res = makeRes()
  await route.handler(makeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), res)
  await tick()
  check('cross-site POST is refused', res.state.status === 403, `${res.state.status}`)
  check('cross-site POST requested no exit', calls.length === 0, JSON.stringify(calls))
}

{
  const { route, calls } = mount()
  const res = makeRes()
  await route.handler(makeReq({ method: 'GET' }), res)
  await tick()
  check('non-POST is refused with 405', res.state.status === 405, `${res.state.status}`)
  check('non-POST requested no exit', calls.length === 0, JSON.stringify(calls))
}

{
  const { route, calls } = mount()
  const res = makeRes()
  await route.handler(makeReq({ body: '{"force":true}' }), res)
  await tick()
  check('force in the body escalates to code 1', calls.length === 1 && calls[0] === 1, JSON.stringify(calls))
}

{
  const { route, calls } = mount()
  const res = makeRes()
  await route.handler(makeReq({ body: 'not json' }), res)
  await tick()
  check('unparseable body still shuts down gracefully', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

// --- the connection layer's own admission gate --------------------------------
{
  check('admit rejection 401 is honoured', rejectionFor({ get: () => ({ admit: () => ({ rejection: 401 }) }) }, makeReq()) === 401)
  check('admit rejection 403 is honoured', rejectionFor({ get: () => ({ admit: () => ({ rejection: 403 }) }) }, makeReq()) === 403)
  check('admitted request passes', rejectionFor({ get: () => ({ admit: () => ({ peer: {} }) }) }, makeReq()) === undefined)
  check('a throwing admit falls back to the fence (loopback passes)',
    rejectionFor({ get: () => ({ admit: () => { throw new Error('x') } }), webRuntime: { trustedHosts: [] } }, makeReq()) === undefined)
  check('a throwing admit falls back to the fence (foreign host refused)',
    rejectionFor(
      { get: () => ({ admit: () => { throw new Error('x') } }), webRuntime: { trustedHosts: [] } },
      makeReq({ headers: { host: 'evil.example.com' } }),
    ) === 403)
  check('a missing connection service still fences',
    rejectionFor({ get: () => undefined, webRuntime: { trustedHosts: [] } }, makeReq({ headers: { host: 'evil.example.com' } })) === 403)
}

{
  // With admission mounted, an unauthenticated request must never reach the exit.
  const { route, calls } = mount({ admit: () => ({ rejection: 401 }) })
  const res = makeRes()
  await route.handler(makeReq(), res)
  await tick()
  check('unauthenticated POST is refused with 401', res.state.status === 401, `${res.state.status} ${res.state.body}`)
  check('unauthenticated POST requested no exit', calls.length === 0, JSON.stringify(calls))
}

{
  const { route, calls } = mount({ admit: () => ({ peer: {} }) })
  const res = makeRes()
  await route.handler(makeReq(), res)
  await tick()
  check('admitted POST answers 200', res.state.status === 200, `${res.state.status}`)
  check('admitted POST scheduled the exit', calls.length === 1 && calls[0] === 0, JSON.stringify(calls))
}

// --- the fence in isolation ---------------------------------------------------
{
  check('fence accepts 127.0.0.1', isTrustedApiRequest({ headers: { host: '127.0.0.1:3080' } }, []))
  check('fence accepts localhost with a port', isTrustedApiRequest({ headers: { host: 'localhost:3080' } }, []))
  check('fence rejects a foreign host', !isTrustedApiRequest({ headers: { host: 'example.com' } }, []))
  check('fence accepts a configured trusted host',
    isTrustedApiRequest({ headers: { host: 'dsh.local:3080' } }, ['dsh.local']))
  check('fence rejects a mismatched origin',
    !isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.test' } }, []))
  check('fence accepts a matching origin',
    isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }, []))
  check('fence rejects cross-site fetch metadata',
    !isTrustedApiRequest({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }, []))
}

// --- the client's decision to close the tab -----------------------------------
// The bug this guards: `fetch` resolves on HTTP 409, so closing the tab
// unconditionally after the request hid a refused shutdown — the tab went away
// while the server stayed up, which reads exactly like a successful exit. The
// decision function is lifted out of the classic-script bundle (a factory body,
// so it cannot be imported) and exercised directly.
const clientChecks = []
{
  const source = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')
  const body = source.match(/async function readReply\(response\) \{[\s\S]*?\n    \}/)
  check('the client decision function is present', body !== null)

  const readReply = body === null
    ? async () => ({ accepted: false })
    : new Function('return ' + body[0].replace('async function readReply', 'async function f'))()

  const reply = (status, payload) => ({
    status,
    json: async () => {
      if (payload === undefined) throw new Error('invalid json')
      return payload
    },
  })
  const accepted = async response => (await readReply(response)).accepted

  clientChecks.push(
    ['no reply counts as accepted (the tree is disposing)', accepted(undefined), true],
    ['an accepted reply closes the tab', accepted(reply(200, { ok: true, route: 'appExit' })), true],
    ['a signal reply closes the tab', accepted(reply(200, { ok: true, route: 'signal' })), true],
    ['the job refusal does NOT close the tab', accepted(reply(409, { ok: false, route: 'blocked' })), false],
    ['the duplicate refusal does NOT close the tab', accepted(reply(409, { ok: false, route: 'duplicate' })), false],
    ['an unreadable reply does NOT close the tab', accepted(reply(200, undefined)), false],
    ['an unauthorised reply does NOT close the tab', accepted(reply(401, { ok: false })), false],
  )

  // The refusal text and job list must survive the parse, so the button can say
  // which work is holding the shutdown up.
  const refused = await readReply(reply(409, {
    ok: false,
    route: 'blocked',
    message: '1 job is still working: long build (running).',
    jobs: [{ id: 'pwsh-1', label: 'long build', status: 'running' }],
  }))
  check('a refusal carries the host message', String(refused.message).includes('long build'), String(refused.message))
  check('a refusal carries the job list', refused.jobs?.[0]?.label === 'long build', JSON.stringify(refused.jobs))
}

for (const [label, promise, expected] of clientChecks) {
  const actual = await promise
  check(label, actual === expected, `got ${actual}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
