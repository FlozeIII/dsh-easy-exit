/**
 * Verify the client bundle is served and carries the CURRENT registration.
 *
 * Usage: node verify-client.mjs <port> <token>
 *
 * A combo script concatenates every plugin of a browser row, so testing for a
 * slot name anywhere in the body is meaningless: another plugin (for example
 * @linxin666/dsh-remote-web-ui) registers 'sidebar.footer.action' and puts that
 * literal in the same body. This therefore anchors on our own register object.
 */

const port = process.argv[2] ?? '3099'
const token = process.argv[3]
if (!token) {
  console.error('usage: node verify-client.mjs <port> <token>')
  process.exit(2)
}
const base = `http://127.0.0.1:${port}`

const exchange = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (exchange.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
const html = await (await fetch(`${base}/`, { headers: { cookie } })).text()

const rows = [...html.matchAll(/["']([^"']*plugins\/\?\?[^"']+)["']/g)].map(m => m[1].replaceAll('&amp;', '&'))
const row = rows.find(r => r.includes('dsh-easy-exit'))
console.log('combo row found        :', row !== undefined)
if (!row) {
  console.log('all combo rows:', rows.length)
  process.exit(1)
}

const url = new URL(row, `${base}/`)
const body = await (await fetch(`${base}${url.pathname}${url.search}`, { headers: { cookie } })).text()

// Anchor on OUR register call: the slot name and our entry id must appear as
// adjacent fields of one registration object.
const HEADER_SLOT = 'conversation.session.header.utilities'
const anchored = new RegExp(
  String.raw`inject\(\s*['"]${HEADER_SLOT.replaceAll('.', String.raw`\.`)}['"][\s\S]{0,400}?name:\s*['"]${HEADER_SLOT.replaceAll('.', String.raw`\.`)}['"],\s*id:\s*['"]easy-exit['"]`,
)

const checks = {
  'bundle served': body.length > 1000,
  '__ModuleLoader__.load': body.includes('__ModuleLoader__.load'),
  'our package registered': /id:\s*['"]dsh-easy-exit['"]/.test(body),
  [`own register into ${HEADER_SLOT}`]: anchored.test(body),
  'exit route present': body.includes('/easy-exit/api'),
  'locale dictionaries': body.includes('退出 DeepSeek Harness'),
}

for (const [label, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log('bundle bytes           :', body.length)

process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
