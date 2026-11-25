import { createRouter } from '@tanstack/react-router'
import { RouteError } from '@/components/route-error'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Catalogue pages change when the merchant edits them; prefetched data is good for half a minute.
    defaultPreloadStaleTime: 30_000,
    defaultErrorComponent: RouteError,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
