/**
 * Capture real WeldHost UI screenshots for help.weldsuite.org docs.
 *
 * Prerequisites:
 *   Platform preview: http://localhost:3000  (vite preview after build)
 *   Docs site:        http://localhost:3010  (next start after build)
 *
 * Usage:
 *   pnpm --filter docs capture-screenshots
 *   pnpm --filter docs capture-screenshots:all   # build, start servers, capture
 */
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { screenshotManifest } from './screenshots.config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const docsRoot = path.resolve(__dirname, '..')
const outputDir = path.resolve(docsRoot, 'public/images/help')

const env = {
  platformBase: process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000',
  docsBase: process.env.DOCS_URL ?? 'http://127.0.0.1:3010',
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (res.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Server not reachable at ${url}`)
}

export async function captureScreenshots() {
  await mkdir(outputDir, { recursive: true })

  await waitForServer(`${env.platformBase}/preview/help-docs?scene=domains`)
  await waitForServer(`${env.docsBase}/`)

  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1480, height: 960 },
    deviceScaleFactor: 2,
  })

  for (const shot of screenshotManifest) {
    const url = shot.url(env)
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector(shot.readySelector ?? shot.selector, {
      timeout: 60_000,
      state: 'visible',
    })
    await page.waitForTimeout(800)
    const target = page.locator(shot.selector).first()
    await target.screenshot({
      path: path.join(outputDir, shot.file),
      animations: 'disabled',
    })
    console.log(`Captured ${shot.file}`)
  }

  await browser.close()
  console.log(`Screenshots saved to ${outputDir}`)
}

async function main() {
  await captureScreenshots()
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
