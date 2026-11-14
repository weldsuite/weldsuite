import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { isEmbedMode, type EmbedMode } from '@weldsuite/forms-embed/protocol'
import type { PublicForm } from '@weldsuite/app-api-client/schemas/weldforms'
import { frameAncestors } from '@/lib/csp'
import { localeFromRequest, type Locale, type PortalStrings } from '@/lib/i18n'
import { dictionaryFor } from '@/lib/server/dictionaries'
import { fetchPublicForm } from '@/lib/server/forms-api'

export interface PageData {
  locale: Locale
  strings: PortalStrings
}

/**
 * The language of the request and its dictionary. A server function, so the
 * dictionaries stay out of the browser bundle: the page carries just the one
 * the reader needs.
 */
export const getPageData = createServerFn({ method: 'GET' }).handler((): PageData => {
  const request = getRequest()
  const locale = localeFromRequest(request.headers.get('cookie'), request.headers.get('accept-language'))
  return { locale, strings: dictionaryFor(locale) }
})

export type FormPageData =
  | (PageData & { kind: 'ready'; form: PublicForm; seed: string })
  | (PageData & { kind: 'not_found' })
  /** Members-only form outside an embed: the page sends the visitor to `href`. */
  | (PageData & { kind: 'redirect'; href: string })

interface FormPageInput {
  publicId: string
  embed?: string
}

/** A short-lived copy of the published form (FE-015: the portal caches it for 60 seconds). */
const CACHE_MS = 60_000
const MAX_CACHED = 200
const cache = new Map<string, { at: number; form: PublicForm }>()

async function cachedForm(request: Request, publicId: string): Promise<{ form: PublicForm } | { status: number }> {
  const hit = cache.get(publicId)
  if (hit && Date.now() - hit.at < CACHE_MS) return { form: hit.form }
  const result = await fetchPublicForm(request, publicId)
  if (!result.ok) return { status: result.status }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
  cache.set(publicId, { at: Date.now(), form: result.form })
  return { form: result.form }
}

/**
 * The form of a page (`/f/:publicId`, `/i/...`): fetched server side so the
 * first paint is branded, with the `frame-ancestors` policy the form's allowed
 * embed domains ask for.
 */
export const getFormPage = createServerFn({ method: 'GET' })
  .validator((input: FormPageInput) => input)
  .handler(async ({ data }): Promise<FormPageData> => {
    const request = getRequest()
    const fallback = localeFromRequest(request.headers.get('cookie'), request.headers.get('accept-language'))
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(data.publicId)) return { kind: 'not_found', locale: fallback, strings: dictionaryFor(fallback) }

    const found = await cachedForm(request, data.publicId)
    if (!('form' in found)) {
      if (found.status === 404) return { kind: 'not_found', locale: fallback, strings: dictionaryFor(fallback) }
      // Anything else is a failure worth showing as one (and logging).
      throw new Error(`forms-api answered ${found.status} for a public form`)
    }

    const { form } = found
    const locale = localeFromRequest(request.headers.get('cookie'), request.headers.get('accept-language'), form.definition?.presentation.language)
    setResponseHeader('Content-Security-Policy', frameAncestors(form.allowedEmbedDomains))
    setResponseHeader('Cache-Control', 'private, no-store')

    const embed: EmbedMode | null = isEmbedMode(data.embed) ? data.embed : null
    if (form.respondentMode === 'members' && form.membersUrl && !embed && form.state === 'open') {
      return { kind: 'redirect', href: form.membersUrl, locale, strings: dictionaryFor(locale) }
    }
    return { kind: 'ready', form, seed: crypto.randomUUID().slice(0, 8), locale, strings: dictionaryFor(locale) }
  })
