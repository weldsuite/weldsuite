/**
 * Build platform + docs, start preview servers, capture screenshots, then stop.
 *
 *   pnpm --filter docs capture-screenshots:all
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { captureScreenshots } from './capture-screenshots.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../..')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}

function startServer(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  })
  child.unref()
  return child
}

async function stopServer(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { shell: true })
  } else {
    process.kill(-child.pid)
  }
}

async function main() {
  console.log('Building platform…')
  await run('pnpm', ['--filter', 'platform', 'build'])

  console.log('Building docs…')
  await run('pnpm', ['--filter', 'docs', 'build'])

  console.log('Starting preview servers…')
  const platform = startServer('pnpm', [
    '--filter',
    'platform',
    'exec',
    'vite',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '3000',
  ])
  const docs = startServer('pnpm', [
    '--filter',
    'docs',
    'exec',
    'next',
    'start',
    '--port',
    '3010',
    '-H',
    '127.0.0.1',
  ])

  try {
    await new Promise((r) => setTimeout(r, 5000))
    await captureScreenshots()
  } finally {
    console.log('Stopping preview servers…')
    await stopServer(platform)
    await stopServer(docs)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
