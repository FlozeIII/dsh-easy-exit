/**
 * Verify the client bundle is actually served and carries the registration.
 *
 * Usage: node verify-client.mjs <port> <token>
 */

const port = process.argv[2] ?? '3099'
const token = process.argv[3]
const base = `http://127.0.0.1:${port}`

const exchange = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (exchange.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
const html = await (await fetch(`${base}/`, { headers: { cookie } })).text()

// Combo URLs live in the document; find the one carrying our package.
const rows = [...html.matchAll(/["']([^"']*plugins\/\?\?[^"']+)["']/g)].map(m => m[1].replaceAll('&amp;', '&'))
const row = rows.find(r => r.includes('dsh-easy-exit'))
console.log('combo row found        :', row !== undefined)
if (!row) {
  console.log('all combo rows:', rows.length)
  process.exit(1)
}

const path = row.startsWith('http') ? row : row.startsWith('/') ? row : new URL(row, `${base}/`).pathname + new URL(row, `${base}/`).search
const body = await (await fetch(`${base}${path}`, { headers: { cookie } })).text()
console.log('bundle bytes           :', body.length)
console.log('__ModuleLoader__.load  :', body.includes('__ModuleLoader__.load'))
console.log('registers dsh-easy-exit:', /id:\s*['"]dsh-easy-exit['"]/.test(body))
console.log('slot sidebar.footer    :', body.includes('sidebar.footer.action'))
console.log('exit route             :', body.includes('/easy-exit/api'))
console.log('locale dictionaries    :', body.includes('退出 DeepSeek Harness'))
process.exit(body.includes('sidebar.footer.action') ? 0 : 1)
