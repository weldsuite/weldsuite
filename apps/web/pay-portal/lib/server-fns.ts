/**
 * The server functions the pages call. They run on the server only: the
 * backend's address stays in the environment (lib/server/config.ts) and the
 * browser talks to this app alone. All of them are POST, so the token (the
 * customer's only credential) is never in a query string.
 */

import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'
import { z } from 'zod'
import { acceptInputSchema, type AcceptResult, type PublicDocument, type Result } from './contract'
import { chooseLocale, type Locale } from './i18n'
import { acceptQuote, createPayment, getDocument } from './server/backend'
import { publicOrigin } from './server/config'

const tokenInput = z.object({ token: z.string().max(300) })
const acceptServerInput = tokenInput.extend({ name: z.string().max(500), email: z.string().max(500), agree: z.boolean() })

export interface LoadedDocument {
  result: Result<PublicDocument>
  /** The page's language: the document's own, else the browser's. */
  locale: Locale
}

/** The browser's language, for a page without a document (the landing page, a dead link). */
export const getBrowserLocale = createServerFn({ method: 'GET' }).handler((): Locale =>
  chooseLocale(null, getRequest().headers.get('accept-language')),
)

/** Reads the document for a link. Opening it is what the backend counts as "viewed". */
export const loadDocument = createServerFn({ method: 'POST' })
  .validator(tokenInput)
  .handler(async ({ data }): Promise<LoadedDocument> => {
    const result = await getDocument(data.token)
    const documentLocale = result.ok ? result.data.locale : null
    // A link that does not work is a 404, so nothing keeps it.
    if (!result.ok && result.reason === 'not_found') setResponseStatus(404)
    return { result, locale: chooseLocale(documentLocale, getRequest().headers.get('accept-language')) }
  })

/** Starts the Mollie payment; the customer comes back to this link's return page. */
export const startPayment = createServerFn({ method: 'POST' })
  .validator(tokenInput)
  .handler(async ({ data }): Promise<Result<{ checkoutUrl: string }>> => {
    const returnUrl = `${publicOrigin(getRequest().headers)}/d/${encodeURIComponent(data.token)}/return`
    return createPayment(data.token, returnUrl)
  })

/** Accepts a quote with the name and email typed on the page. */
export const acceptQuoteFn = createServerFn({ method: 'POST' })
  .validator(acceptServerInput)
  .handler(async ({ data }): Promise<Result<AcceptResult>> => {
    const { token, ...fields } = data
    const input = acceptInputSchema.safeParse(fields)
    if (!input.success) return { ok: false, reason: 'invalid' }
    return acceptQuote(token, input.data)
  })
