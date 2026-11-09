/**
 * `Content-Security-Policy: frame-ancestors` for a form page, from the form's
 * allowed embed domains. Empty (or `*`) means any site may embed it, which is
 * the default; a list restricts framing to those sites.
 */

/** One allowed domain as a CSP source: a bare host gets https, a full origin is kept as its origin. */
function toSource(entry: string): string | null {
  const value = entry.trim()
  if (!value) return null
  if (value === '*') return '*'
  // Anything that could break out of the directive is refused.
  if (/[\s;,'"]/.test(value)) return null
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).origin
    } catch {
      return null
    }
  }
  const host = value.replace(/\/.*$/, '')
  if (!/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return null
  return /^localhost(:\d+)?$/i.test(host) ? `http://${host} https://${host}` : `https://${host}`
}

export function frameAncestors(domains: readonly string[]): string {
  const sources = domains.map(toSource).filter((s): s is string => s !== null)
  if (domains.length === 0 || sources.includes('*')) return 'frame-ancestors *'
  // Every entry was unusable: refuse framing rather than open it up.
  if (sources.length === 0) return "frame-ancestors 'none'"
  return `frame-ancestors ${sources.join(' ')}`
}
