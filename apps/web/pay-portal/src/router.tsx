import { createRouter } from '@tanstack/react-router'
import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { MessageScreen } from '@/components/message-screen'
import { dictionaries } from '@/lib/i18n'
import { routeTree } from './routeTree.gen'

/**
 * The CSP nonce of the request being rendered (node/server.mjs sets the header
 * on the request it hands to Start, replacing any the customer sent). Start
 * stamps `ssr.nonce` on its inline scripts, module script and preload links;
 * without it the policy would block hydration. The browser needs none.
 */
const requestNonce = createIsomorphicFn()
  .server(() => getRequestHeader('x-csp-nonce') ?? undefined)
  .client(() => undefined)

export function getRouter() {
  const nonce = requestNonce()
  return createRouter({
    routeTree,
    ssr: nonce ? { nonce } : undefined,
    scrollRestoration: true,
    // A document is read when it is opened ("viewed"): never in the background on a hover.
    defaultPreload: false,
    defaultErrorComponent: ({ reset }) => {
      const t = dictionaries.en
      return (
        <MessageScreen title={t.error.title} body={t.error.body}>
          <button type="button" className="mx-auto underline" onClick={reset}>
            {t.error.retry}
          </button>
        </MessageScreen>
      )
    },
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
