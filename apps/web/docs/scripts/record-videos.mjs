/**
 * Record support videos for help.weldsuite.org docs.
 *
 * Prerequisite: the platform running on PLATFORM_URL (default
 * http://127.0.0.1:3000), e.g. `pnpm --filter platform dev`.
 *
 * Usage:
 *   pnpm --filter docs record-videos                       # all videos
 *   pnpm --filter docs record-videos weldmail-send-email   # one video
 */
import { chromium } from '@playwright/test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordVideo, VIDEO_SCALE } from './video-director.mjs'
import { videoManifest } from './videos.config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.resolve(__dirname, '../public/videos/help')
const workDir = path.join(tmpdir(), 'weldsuite-help-videos')

const env = {
  platformBase: process.env.PLATFORM_URL ?? 'http://127.0.0.1:3000',
}

async function main() {
  const only = process.argv.slice(2)
  const videos = only.length ? videoManifest.filter((v) => only.includes(v.name)) : videoManifest
  if (videos.length === 0) {
    throw new Error(`No video named ${only.join(', ')}. Known: ${videoManifest.map((v) => v.name).join(', ')}`)
  }

  // The DevTools screencast captures in CSS pixels unless the browser itself
  // renders at the higher scale, so force it to get 1080p frames.
  const browser = await chromium.launch({ args: [`--force-device-scale-factor=${VIDEO_SCALE}`] })
  try {
    for (const video of videos) {
      const started = Date.now()
      const file = await recordVideo(browser, video, env, outputDir, workDir)
      console.log(`Recorded ${path.relative(process.cwd(), file)} in ${((Date.now() - started) / 1000).toFixed(0)}s`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
