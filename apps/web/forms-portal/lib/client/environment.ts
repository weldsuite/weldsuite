/**
 * What the page learns about the visitor's browser and the link they came
 * through: hidden fields, prefilled answers and UTM tags from the query string,
 * the referrer, and a simple device / browser / OS guess. Pure functions, so
 * they are testable; the browser-only reads sit in `collectMetadata`.
 */

import { choicesOf, fieldsOf, normalizeAnswer, type Answers, type ChoiceAnswer, type FieldBlock, type FormDefinition } from '@weldsuite/forms-engine'

export type Device = 'desktop' | 'tablet' | 'phone'

export interface ParsedAgent {
  device: Device
  browser: string
  os: string
}

/** Tablet, phone or desktop; a narrow viewport counts as a phone unless it is a Mac. */
function guessDevice(ua: string, viewportWidth: number | undefined): Device {
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'tablet'
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'phone'
  if (viewportWidth !== undefined && viewportWidth > 0 && viewportWidth < 600 && /Macintosh/.test(ua) === false) return 'phone'
  return 'desktop'
}

function guessBrowser(ua: string): string {
  if (/edg(e|a|ios)?\//i.test(ua)) return 'Edge'
  if (/opr\/|opera/i.test(ua)) return 'Opera'
  if (/firefox\/|fxios\//i.test(ua)) return 'Firefox'
  if (/chrome\/|crios\//i.test(ua)) return 'Chrome'
  if (/safari\//i.test(ua)) return 'Safari'
  return 'Other'
}

function guessOs(ua: string): string {
  if (/windows/i.test(ua)) return 'Windows'
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS'
  if (/android/i.test(ua)) return 'Android'
  if (/cros/i.test(ua)) return 'ChromeOS'
  if (/mac os x|macintosh/i.test(ua)) return 'macOS'
  if (/linux/i.test(ua)) return 'Linux'
  return 'Other'
}

/** A deliberately small user-agent reader: enough for "Chrome on Windows, desktop" in the results. */
export function parseUserAgent(ua: string, viewportWidth?: number): ParsedAgent {
  return { device: guessDevice(ua, viewportWidth), browser: guessBrowser(ua), os: guessOs(ua) }
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

const YES_WORDS = new Set(['yes', 'true', '1', 'y', 'ja'])
const NO_WORDS = new Set(['no', 'false', '0', 'n', 'nee'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Choices named by label (any case) or id; several by repeating the name or separating them with commas. */
function prefillChoices(field: FieldBlock, values: string[]): ChoiceAnswer | undefined {
  const choices = choicesOf(field)
  const find = (text: string) => {
    const needle = text.trim().toLowerCase()
    return choices.find((c) => c.id === text.trim() || c.label.trim().toLowerCase() === needle)
  }
  const ids: string[] = []
  for (const value of values) {
    const whole = find(value)
    const matched = whole ? [whole] : value.split(',').map(find)
    for (const choice of matched) if (choice && !ids.includes(choice.id)) ids.push(choice.id)
  }
  if (ids.length === 0) return undefined
  const multiple = 'multiple' in field.properties && field.properties.multiple === true
  return { choiceIds: multiple ? ids : ids.slice(0, 1) }
}

/** The raw answer one question gets from its query values, or undefined when it cannot be prefilled. */
function prefillValue(field: FieldBlock, values: string[]): unknown {
  const first = (values[0] ?? '').slice(0, 1000).trim()
  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'website':
      return first
    case 'date':
      return DATE_RE.test(first) ? first : undefined
    case 'number':
    case 'rating':
    case 'opinion_scale':
    case 'nps': {
      const n = Number(first)
      return first !== '' && Number.isFinite(n) ? n : undefined
    }
    case 'yes_no': {
      const word = first.toLowerCase()
      if (YES_WORDS.has(word)) return true
      return NO_WORDS.has(word) ? false : undefined
    }
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
      return prefillChoices(field, values)
    default:
      // Consent, files, signatures, rankings, matrices, contact info and addresses are the respondent's to give.
      return undefined
  }
}

/**
 * Answers from the query string: a name that is a question's reference fills
 * that question in (`?email=ada@example.com&plan=Pro`). Text, numbers, dates
 * (`YYYY-MM-DD`), yes/no and choices can be prefilled; a value that does not
 * fit the question is ignored. The respondent sees the answer and can change
 * it, and forms-api validates it like any other.
 */
export function prefillFromSearch(search: string, definition: Pick<FormDefinition, 'blocks'>): Answers {
  const params = new URLSearchParams(search)
  const out: Answers = {}
  for (const field of fieldsOf(definition)) {
    if (RESERVED.has(field.ref)) continue
    const values = params.getAll(field.ref)
    if (values.length === 0) continue
    const value = normalizeAnswer(field, prefillValue(field, values))
    if (value !== undefined) out[field.id] = value
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
