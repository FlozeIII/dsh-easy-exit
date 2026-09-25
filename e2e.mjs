/**
 * Live end-to-end test against a real `dsh web` instance:
 * token exchange -> authenticated POST to the plugin's exit route -> observe the
 * server actually stopping.
 *
 * Usage: node e2e.mjs <port> <token>
 */

const port = process.argv[2] ?? '3099'
const token = process.argv[3]
if (!token) {
  console.error('usage: node e2e.mjs <port> <token>')
  process.exit(2)
}

const base = `http://127.0.0.1:${port}`
const wait = ms => new Promise(r => setTimeout(r, ms))

/** Record whether the port still accepts connections. */
async function isUp() {
  try {
    const response = await fetch(`${base}/`, { redirect: 'manual' })
    return response.status > 0
  } catch {
    return false
  }
}

console.log('1. server reachable        :', await isUp())

// The root exchange accepts the token, sets the signed cookie and redirects to
// the clean URL. In Node we keep the Set-Cookie ourselves.
const exchange = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const setCookie = exchange.headers.getSetCookie?.() ?? []
const cookie = setCookie.map(entry => entry.split(';')[0]).join('; ')
console.log('2. token exchange status   :', exchange.status)
console.log('   cookie acquired         :', cookie.length > 0 ? 'yes' : 'NO')

const route = `${base}/easy-exit/api`

// Unauthenticated call: the connection fence answers 401 before our handler.
const unauth = await fetch(route, { method: 'POST' })
console.log('3. unauthenticated POST    :', unauth.status, '(expect 401)')

// Authenticated call: this must shut the server down.
let status = 'no response'
let body = ''
try {
  const authed = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: '{}',
  })
  status = authed.status
  body = await authed.text()
} catch (error) {
  status = `connection dropped: ${error?.cause?.code ?? error?.message}`
}
console.log('4. authenticated POST      :', status)
if (body) console.log('   body                    :', body)

// The tree disposes, then the process leaves; allow the 5 s ceiling too.
let downAfter = null
for (let i = 1; i <= 20; i++) {
  await wait(500)
  if (!(await isUp())) { downAfter = i * 0.5; break }
}
console.log('5. server stopped          :', downAfter === null ? 'NO — still listening after 10 s' : `yes, after ~${downAfter}s`)
process.exit(downAfter === null ? 1 : 0)
