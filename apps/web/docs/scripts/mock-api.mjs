/**
 * Answers the platform's API calls from fixtures, for preview routes running
 * without a backend (see apps/web/platform/contexts/preview-mode-context.tsx).
 *
 * `handlers` is a list of `[matcher, handler]`. The matcher is a string like
 * "GET /api/mail-accounts" or a RegExp tested against that same
 * "METHOD /path" signature. The handler receives `{ url, json }` and returns
 * the JSON body, or `{ status, body }`. Unmatched calls get a 404: shell
 * widgets (badges, credits, chat) already tolerate a failing API, whereas a
 * guessed success body of the wrong shape can crash them.
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
}

const NOT_MOCKED = { error: { code: 'not_mocked', message: 'No fixture for this request' } }

export async function mockApi(page, platformOrigin, handlers) {
  await page.route(
    (url) => url.pathname.startsWith('/api/') && url.origin !== platformOrigin,
    async (route) => {
      const request = route.request()
      const method = request.method()
      if (method === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS_HEADERS })
        return
      }
      const url = new URL(request.url())
      const signature = `${method} ${url.pathname}`
      const match = handlers.find(([matcher]) =>
        typeof matcher === 'string' ? matcher === signature : matcher.test(signature),
      )

      let status = 404
      let body = NOT_MOCKED
      if (match) {
        let json = null
        try {
          json = request.postDataJSON()
        } catch {
          // not a JSON body
        }
        status = 200
        const result = await match[1]({ url, json })
        if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
          ;({ status, body } = result)
        } else {
          body = result
        }
      }
      await route.fulfill({
        status,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
  )
}
