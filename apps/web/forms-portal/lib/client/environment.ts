/**
 * What the page learns about the visitor's browser and the link they came
 * through: hidden fields and UTM tags from the query string, the referrer, and
 * a simple device / browser / OS guess. Pure functions, so they are testable;
 * the browser-only reads sit in `collectMetadata`.
 */

export type Device = 'desktop' | 'tablet' | 'phone'

export interface ParsedAgent {
  device: Device
  browser: string
  os: string
}

/** A deliberately small user-agent reader: enough for "Chrome on Windows, desktop" in the results. */
export function parseUserAgent(ua: string, viewportWidth?: number): ParsedAgent {
  let device: Device = 'desktop'
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) device = 'tablet'
  else if (/mobi|iphone|ipod|android/i.test(ua)) device = 'phone'
  else if (viewportWidth !== undefined && viewportWidth > 0 && viewportWidth < 600 && /Macintosh/.test(ua) === false) device = 'phone'

  let browser = 'Other'
  if (/edg(e|a|ios)?\//i.test(ua)) browser = 'Edge'
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera'
  else if (/firefox\/|fxios\//i.test(ua)) browser = 'Firefox'
  else if (/chrome\/|crios\//i.test(ua)) browser = 'Chrome'
  else if (/safari\//i.test(ua)) browser = 'Safari'

  let os = 'Other'
  if (/windows/i.test(ua)) os = 'Windows'
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/cros/i.test(ua)) os = 'ChromeOS'
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS'
  else if (/linux/i.test(ua)) os = 'Linux'

  return { device, browser, os }
}

/** Query-string names that belong to the portal, never to a hidden field. */
const RESERVED = new Set(['embed', 'invitation', 'versionId'])

/**
 * Values for the form's declared hidden fields from the query string. Names
 * the form does not declare are dropped, so a link cannot smuggle in extra
 * data. Values are cut to the 1000 characters forms-api accepts.
 */
export function hiddenFromSearch(search: string, declared: readonly string[]): Record<string, string> {
  const params = new URLSearchParams(search)
  const allowed = new Set(declared)
  const out: Record<string, string> = {}
  for (const [name, value] of params) {
    if (RESERVED.has(name) || !allowed.has(name) || name in out) continue
    out[name] = value.slice(0, 1000)
  }
  return out
}

/** `utm_*` tags from the query string (at most ten, values cut to 200 characters). */
export function utmFromSearch(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of new URLSearchParams(search)) {
    if (!/^utm_[a-z0-9_]{1,40}$/i.test(name) || name in out) continue
    out[name.toLowerCase()] = value.slice(0, 200)
    if (Object.keys(out).length >= 10) break
  }
  return out
}

export interface SessionMeta {
  referrer?: string
  utm?: Record<string, string>
  source?: string
  device?: Device
  browser?: string
  os?: string
}

/** The metadata sent when a session starts. Browser only. */
export function collectMetadata(source: string, search: string): SessionMeta {
  const agent = parseUserAgent(navigator.userAgent, window.innerWidth)
  const meta: SessionMeta = { source, device: agent.device, browser: agent.browser, os: agent.os }
  if (document.referrer) meta.referrer = document.referrer.slice(0, 2000)
  const utm = utmFromSearch(search)
  if (Object.keys(utm).length > 0) meta.utm = utm
  return meta
}

/** Only http and https may be navigated to or linked: an author-controlled `javascript:` URL must never run. */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid')
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
