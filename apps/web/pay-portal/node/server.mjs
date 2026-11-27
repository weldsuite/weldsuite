// The pay portal's Node server, for its container on Kubernetes (ADR BOOKS-014).
// `pnpm build` writes the app to dist/: dist/client (the browser's files) and
// dist/server/server.js (TanStack Start's fetch handler, every dependency
// bundled). This file serves both with Node's own http module, so the image
// needs nothing but Node and dist/ (distroless).
//
//   node node/server.mjs        PORT (3000), HOST (0.0.0.0)
//   PAY_PORTAL_BACKEND_URL      the WeldSuite server, e.g. http://weldsuite.weldsuite.svc:8789
//   PAY_PORTAL_PUBLIC_URL       this portal's own origin (optional: taken from the request)
//
// GET /healthz answers without touching the app, for the probes. Behind the
// ingress, X-Forwarded-Proto says whether the customer came over HTTPS. The
// request URL carries the link's token, so nothing here logs it.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contentSecurityPolicy, newNonce } from './security.mjs'

const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const client = join(root, 'client')
const { default: app } = await import(pathToFileURL(join(root, 'server', 'server.js')).href)

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** A file of the client build for this path, or null. */
async function clientFile(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const file = resolve(client, `.${decoded}`)
  if (!file.startsWith(client + sep)) return null
  const info = await stat(file).catch(() => null)
  return info?.isFile() ? { file, size: info.size } : null
}

function serveFile(req, res, pathname, { file, size }) {
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    // Vite names everything under /assets by its content.
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

/** The URL the customer asked for: HTTPS when the ingress says so. */
function requestUrl(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return new URL(req.url ?? '/', `${proto}://${req.headers.host ?? 'localhost'}`)
}

/** The customer's request as a fetch Request. */
function toRequest(req, url, nonce) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  // Only this server decides the nonce: whatever the customer sent is replaced.
  headers.set('x-csp-nonce', nonce)
  const controller = new AbortController()
  req.on('close', () => {
    if (!req.complete) controller.abort()
  })
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
    signal: controller.signal,
  })
}

async function send(res, response, head, nonce) {
  const headers = {}
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  headers['content-security-policy'] = contentSecurityPolicy(nonce)
  res.writeHead(response.status, headers)
  if (head || !response.body) return res.end()
  const body = Readable.fromWeb(response.body)
  body.on('error', (error) => res.destroy(error))
  body.pipe(res)
}

const server = createServer(async (req, res) => {
  try {
    const url = requestUrl(req)
    const { pathname } = url
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      return res.end('ok')
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = pathname === '/' ? null : await clientFile(pathname)
      if (file) return serveFile(req, res, pathname, file)
    }
    const nonce = newNonce()
    await send(res, await app.fetch(toRequest(req, url, nonce), { context: { nonce } }), req.method === 'HEAD', nonce)
  } catch (error) {
    // The error, never the request: its URL holds the link's token.
    console.error('[pay-portal]', error instanceof Error ? error.message : 'request failed')
    if (res.headersSent) return res.destroy()
    res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }))
  }
})

const { PORT = '3000', HOST = '0.0.0.0' } = process.env
const port = Number.parseInt(PORT, 10)
server.listen(port, HOST, () => {
  console.log(`[pay-portal] listening on ${port}`)
})

// Kubernetes sends SIGTERM, then waits terminationGracePeriodSeconds: finish
// the requests in flight, take no new ones.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
