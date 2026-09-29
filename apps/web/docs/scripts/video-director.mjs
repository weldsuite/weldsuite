/**
 * Screen-recording helpers for help.weldsuite.org support videos.
 *
 * A "director" drives a Playwright page like a person would (smooth cursor
 * moves, clicks, human-speed typing) while an injected overlay draws the
 * cursor, click ripples and step captions. Frames come from the Chrome
 * DevTools screencast (sharp JPEGs at device resolution) and are encoded to
 * an H.264 MP4 with ffmpeg, much crisper than Playwright's built-in VP8
 * recorder, which blurs small UI text.
 */
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const VIDEO_VIEWPORT = { width: 1280, height: 720 }
export const VIDEO_SCALE = 1.5 // 1280x720 CSS px -> 1920x1080 video
const FPS = 30

async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  try {
    const mod = await import('@ffmpeg-installer/ffmpeg')
    return (mod.default ?? mod).path
  } catch {
    return 'ffmpeg'
  }
}

/**
 * Overlay injected into every page before app code runs. Pure DOM so it works
 * on any page, and pointer-events: none so it never intercepts real clicks.
 */
function overlayInitScript() {
  const install = () => {
    if (document.getElementById('__video-overlay')) return
    const root = document.createElement('div')
    root.id = '__video-overlay'
    root.innerHTML = `
      <style>
        #__video-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
        #__video-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(-100px, -100px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
        .__video-ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 9999px; background: rgba(99,102,241,.35); border: 2px solid rgba(99,102,241,.9); animation: __video-ripple .55s ease-out forwards; }
        @keyframes __video-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
        #__video-caption { position: absolute; left: 50%; bottom: 28px; transform: translate(-50%, 16px); max-width: 78%; padding: 12px 20px; border-radius: 14px; background: rgba(15,23,42,.92); color: #fff; font-size: 19px; font-weight: 500; line-height: 1.35; box-shadow: 0 10px 30px rgba(0,0,0,.3); opacity: 0; transition: opacity .3s ease, transform .3s ease; display: flex; align-items: center; gap: 12px; }
        #__video-caption.visible { opacity: 1; transform: translate(-50%, 0); }
        #__video-caption .step { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9999px; background: #6366f1; font-size: 15px; font-weight: 700; }
        #__video-caption .step:empty { display: none; }
        #__video-card { position: absolute; inset: 0; display: grid; place-items: center; background: linear-gradient(135deg, #0f172a, #312e81); color: #fff; opacity: 0; transition: opacity .45s ease; text-align: center; }
        #__video-card.visible { opacity: 1; }
        #__video-card.visible ~ #__video-cursor { opacity: 0; }
        #__video-card .eyebrow { font-size: 16px; letter-spacing: .14em; text-transform: uppercase; color: #a5b4fc; font-weight: 600; }
        #__video-card .title { margin-top: 14px; font-size: 44px; font-weight: 700; letter-spacing: -.02em; }
        #__video-card .subtitle { margin-top: 12px; font-size: 20px; color: #cbd5e1; }
      </style>
      <div id="__video-card"><div><div class="eyebrow"></div><div class="title"></div><div class="subtitle"></div></div></div>
      <div id="__video-caption"><span class="step"></span><span class="text"></span></div>
      <svg id="__video-cursor" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.4 2.9 6.6 3-1.3-2.9-6.5h6.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
    `
    document.documentElement.appendChild(root)
    const cursor = root.querySelector('#__video-cursor')
    document.addEventListener(
      'mousemove',
      (e) => {
        cursor.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 3}px)`
      },
      true,
    )
    document.addEventListener(
      'mousedown',
      (e) => {
        const ripple = document.createElement('div')
        ripple.className = '__video-ripple'
        ripple.style.left = `${e.clientX}px`
        ripple.style.top = `${e.clientY}px`
        root.insertBefore(ripple, cursor)
        setTimeout(() => ripple.remove(), 600)
      },
      true,
    )
    window.__videoOverlay = {
      caption(text, step) {
        const el = root.querySelector('#__video-caption')
        if (!text) {
          el.classList.remove('visible')
          return
        }
        el.querySelector('.step').textContent = step ?? ''
        el.querySelector('.text').textContent = text
        el.classList.add('visible')
      },
      card(content, instant = false) {
        const el = root.querySelector('#__video-card')
        el.style.transition = instant ? 'none' : ''
        if (!content) {
          el.classList.remove('visible')
          return
        }
        el.querySelector('.eyebrow').textContent = content.eyebrow ?? ''
        el.querySelector('.title').textContent = content.title ?? ''
        el.querySelector('.subtitle').textContent = content.subtitle ?? ''
        el.classList.add('visible')
      },
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install)
  } else {
    install()
  }
}

/** Records a CDP screencast into numbered JPEGs with their timestamps. */
class ScreencastRecorder {
  constructor(page, frameDir) {
    this.page = page
    this.frameDir = frameDir
    this.frames = []
    this.pending = []
  }

  async start() {
    await mkdir(this.frameDir, { recursive: true })
    this.cdp = await this.page.context().newCDPSession(this.page)
    this.cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = path.join(this.frameDir, `f${String(this.frames.length).padStart(6, '0')}.jpg`)
      this.frames.push({ file, timestamp: metadata.timestamp })
      this.pending.push(writeFile(file, Buffer.from(data, 'base64')))
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      maxWidth: Math.round(VIDEO_VIEWPORT.width * VIDEO_SCALE),
      maxHeight: Math.round(VIDEO_VIEWPORT.height * VIDEO_SCALE),
      everyNthFrame: 1,
    })
  }

  async stop() {
    // The screencast only emits on repaint; stamp the final frame so the
    // last pause is held for its real length.
    const endedAt = Date.now() / 1000
    await this.cdp.send('Page.stopScreencast')
    await Promise.all(this.pending)
    return { frames: this.frames, endedAt }
  }
}

async function encodeMp4({ frames, endedAt }, frameDir, outFile, trimStart = 0) {
  const usable = frames.filter((f) => f.timestamp >= trimStart)
  // Keep the frame that was on screen when trimming started.
  const before = frames.filter((f) => f.timestamp < trimStart).at(-1)
  if (before) usable.unshift({ ...before, timestamp: trimStart })
  if (usable.length === 0) throw new Error('No frames captured')

  // Absolute forward-slash paths: the concat demuxer can't resolve relative
  // entries against a Windows (backslash) list path.
  const entry = (f) => `file '${f.file.replaceAll('\\', '/')}'`
  const lines = ['ffconcat version 1.0']
  for (let i = 0; i < usable.length; i++) {
    const next = usable[i + 1]?.timestamp ?? endedAt
    const duration = Math.max(next - usable[i].timestamp, 1 / FPS)
    lines.push(entry(usable[i]), `duration ${duration.toFixed(4)}`)
  }
  lines.push(entry(usable.at(-1)))
  const listFile = path.join(frameDir, 'frames.ffconcat')
  await writeFile(listFile, lines.join('\n'))

  const ffmpeg = await resolveFfmpeg()
  await execFileAsync(
    ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-vf', `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '20',
      '-tune', 'stillimage',
      '-movflags', '+faststart',
      outFile,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  )
}

/**
 * The API a video script uses. Every action waits a little afterwards so the
 * viewer can follow along; tweak pacing with `pause()`.
 */
export class Director {
  constructor(page) {
    this.page = page
    this.step = 0
  }

  pause(ms = 600) {
    return this.page.waitForTimeout(ms)
  }

  /**
   * Full-screen title card. `instant` skips the fade-in (opening frame);
   * `keep` leaves it up (closing card, so the video ends on it).
   */
  async card(content, holdMs = 2200, { instant = false, keep = false } = {}) {
    await this.page.evaluate(([c, i]) => window.__videoOverlay?.card(c, i), [content, instant])
    await this.pause(holdMs)
    if (keep) return
    await this.page.evaluate(() => window.__videoOverlay?.card(null))
    await this.pause(500)
  }

  /** Show a numbered step caption. Pass `{ numbered: false }` for a plain note. */
  async caption(text, { numbered = true, holdMs = 900 } = {}) {
    const step = numbered ? String(++this.step) : undefined
    await this.page.evaluate(([t, s]) => window.__videoOverlay?.caption(t, s), [text, step])
    await this.pause(holdMs)
  }

  async hideCaption() {
    await this.page.evaluate(() => window.__videoOverlay?.caption(null))
    await this.pause(400)
  }

  async moveTo(target, { durationMs = 700 } = {}) {
    const locator = typeof target === 'string' ? this.page.locator(target).first() : target
    await locator.waitFor({ state: 'visible' })
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox()
    if (!box) throw new Error(`Cannot move to invisible element: ${target}`)
    const x = box.x + Math.min(box.width / 2, 60)
    const y = box.y + box.height / 2
    const steps = Math.max(8, Math.round(durationMs / 16))
    await this.page.mouse.move(x, y, { steps })
    await this.pause(180)
    return locator
  }

  async click(target, opts) {
    const locator = await this.moveTo(target, opts)
    await locator.click()
    await this.pause(500)
    return locator
  }

  /** Click into a field and type like a person (≈ 20 chars/s). */
  async type(target, text, { delay = 45 } = {}) {
    const locator = await this.click(target)
    await this.page.keyboard.type(text, { delay })
    await this.pause(400)
    return locator
  }
}

/**
 * Record one video. `run(director, page)` performs the scripted steps; the
 * recording starts once `readySelector` is visible so loading spinners are
 * never in the video. Optional `intro` / `outro` title cards bracket it, and
 * the intro card doubles as the poster image.
 */
export async function recordVideo(browser, video, env, outputDir, workDir) {
  const context = await browser.newContext({
    viewport: VIDEO_VIEWPORT,
    deviceScaleFactor: VIDEO_SCALE,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  })
  await context.addInitScript(overlayInitScript)
  const page = await context.newPage()
  if (video.mockRoutes) await video.mockRoutes(page, env)

  const frameDir = path.join(workDir, video.name)
  await rm(frameDir, { recursive: true, force: true })
  const recorder = new ScreencastRecorder(page, frameDir)
  await recorder.start()

  await page.goto(video.url(env), { waitUntil: 'networkidle' })
  await page.waitForSelector(video.readySelector, { state: 'visible', timeout: 60_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)
  const director = new Director(page)
  await mkdir(outputDir, { recursive: true })
  const posterFile = path.join(outputDir, `${video.name}.jpg`)
  if (video.intro) {
    await page.evaluate((c) => window.__videoOverlay?.card(c, true), video.intro)
    await page.waitForTimeout(300)
    await page.screenshot({ path: posterFile, type: 'jpeg', quality: 88 })
  }
  const trimStart = Date.now() / 1000

  if (video.intro) await director.card(video.intro, 2400, { instant: true })
  await video.run(director, page)

  if (video.outro) await director.card(video.outro, 2800, { keep: true })

  const result = await recorder.stop()
  const outFile = path.join(outputDir, `${video.name}.mp4`)
  await encodeMp4(result, frameDir, outFile, trimStart)
  if (!video.intro) await page.screenshot({ path: posterFile, type: 'jpeg', quality: 88 })
  await context.close()
  await rm(frameDir, { recursive: true, force: true })
  return outFile
}
