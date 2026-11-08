import { createRouter } from '@tanstack/react-router';
import { NotFound, RouteError } from '@/components/route-error';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Every page reads live data, as the Next pages did with
    // `dynamic = 'force-dynamic'`: no preloading on hover, no stale reuse.
    defaultPreload: false,
    defaultStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
