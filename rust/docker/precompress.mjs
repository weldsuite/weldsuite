// Writes a .br and a .gz next to every compressible file of a built SPA, for
// the weldsuite image (rust/Dockerfile). The server sends the one the browser
// accepts (bins/weldsuite/src/spa.rs), so nothing is compressed per request.
// A variant that saves less than a tenth is not written.
//
//   node precompress.mjs <dir>

/* global process */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const COMPRESSIBLE = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt', '.wasm', '.webmanifest', '.xml'])
const MIN_BYTES = 1024
const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile() && COMPRESSIBLE.has(extname(entry.name).toLowerCase())) yield path
  }
}

async function compress(path) {
  const content = await readFile(path)
  if (content.length < MIN_BYTES) return [0, 0]
  const variants = await Promise.all([
    brotli(content, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: content.length,
      },
    }).then((bytes) => ['.br', bytes]),
    gz(content, { level: constants.Z_BEST_COMPRESSION }).then((bytes) => ['.gz', bytes]),
  ])
  let written = 0
  for (const [suffix, bytes] of variants) {
    if (bytes.length > content.length * 0.9) continue
    await writeFile(path + suffix, bytes)
    written += 1
  }
  return [content.length, written]
}

const root = process.argv[2]
if (!root) {
  console.error('usage: node precompress.mjs <dir>')
  process.exit(2)
}
const queue = []
for await (const path of files(root)) queue.push(path)
let bytes = 0
let variants = 0
const workers = Array.from({ length: Math.max(2, availableParallelism()) }, async () => {
  for (let path = queue.pop(); path; path = queue.pop()) {
    const [size, written] = await compress(path)
    bytes += size
    variants += written
  }
})
await Promise.all(workers)
console.log(`precompressed ${(bytes / 1048576).toFixed(1)} MiB into ${variants} variants`)
