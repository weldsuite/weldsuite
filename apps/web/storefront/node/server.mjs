// The storefront renderer's Node server (ADR COM-015). `pnpm build` writes the
// app to dist/: dist/client (the browser's files) and dist/server/server.js
// (TanStack Start's fetch handler, every dependency bundled). This file serves
// both with Node's own http module, so the image needs nothing but Node and
// dist/ (distroless).
//
//   node node/server.mjs        PORT (3031), HOST (0.0.0.0)
//
// The renderer is only reached through the WeldSuite server's storefront edge,
// which adds `X-Storefront-Edge: <STOREFRONT_RENDERER_SECRET>` to every request
// it proxies, static files included. Anything without it gets a 404, except
// GET /healthz, which answers without touching the app, for the probes.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EDGE_HEADER, isEdgeSecret, isOpenPath } from './edge-auth.mjs'

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
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

/** The URL the shopper asked for: HTTPS when the edge says so. */
function requestUrl(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return new URL(req.url ?? '/', `${proto}://${req.headers.host ?? 'localhost'}`)
}

/** The request as a fetch Request. */
function toRequest(req, url) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
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

async function send(res, response, head) {
  const headers = {}
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers)
  if (head || !response.body) return res.end()
  const body = Readable.fromWeb(response.body)
  body.on('error', (error) => res.destroy(error))
  body.pipe(res)
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('Not found')
}

/** An environment variable (read by name: the image sets these, not the build). */
const env = (name) => process.env[name]?.trim() || undefined

const secret = env('STOREFRONT_RENDERER_SECRET')
if (!secret) console.error('[storefront] STOREFRONT_RENDERER_SECRET is not set: every request will be refused')

const server = createServer(async (req, res) => {
  try {
    const url = requestUrl(req)
    const { pathname } = url
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      return res.end('ok')
    }
    if (!isOpenPath(pathname) && !isEdgeSecret(req.headers[EDGE_HEADER], secret)) return notFound(res)
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = pathname === '/' ? null : await clientFile(pathname)
      if (file) return serveFile(req, res, pathname, file)
    }
    await send(res, await app.fetch(toRequest(req, url)), req.method === 'HEAD')
  } catch (error) {
    console.error('[storefront]', error instanceof Error ? error.message : error)
    if (res.headersSent) return res.destroy()
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Something went wrong')
  }
})

const port = Number.parseInt(env('PORT') ?? '3031', 10)
server.listen(port, env('HOST') ?? '0.0.0.0', () => {
  console.log(`[storefront] listening on ${port}`)
})

// Kubernetes sends SIGTERM, then waits terminationGracePeriodSeconds: finish
// the requests in flight, take no new ones.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
