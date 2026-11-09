import { notFound } from '@tanstack/react-router';
import { createMiddleware } from '@tanstack/react-start';

/**
 * Which build of the console this is, fixed when it is built (ADR FE-018):
 *
 * - Global: the Cloudflare Worker (`pnpm build`), with Neon, Stripe's billing
 *   worker, the workspace worker, Telnyx and the other Global services.
 * - Kubernetes: the Node server for the EU and self-hosted editions
 *   (`pnpm build:node`, Vite's `node` mode). It has the master and tenant
 *   databases and the Rust server, and none of Global's services.
 *
 * A compile-time constant, so the bundler drops the code the other build
 * never runs.
 */
export const GLOBAL: boolean = import.meta.env.MODE !== 'node';

/**
 * For a route that only Global has: `beforeLoad: globalOnlyRoute`. The page
 * answers 404 on Kubernetes, the same as a path that doesn't exist.
 */
export function globalOnlyRoute(): void {
  if (!GLOBAL) throw notFound();
}

/**
 * For a server function that only Global has (its page's loader, or an action
 * calling a Global service): `.middleware([globalOnly])`. A route guard alone
 * isn't enough, since a server function can be called without its page.
 */
export const globalOnly = createMiddleware({ type: 'function' }).server(({ next }) => {
  if (!GLOBAL) throw notFound();
  return next();
});

/**
 * For a route only the Kubernetes editions have (the staff list and feature
 * flags, which Global keeps in Clerk and Flagship): 404 on Global.
 */
export function kubernetesOnlyRoute(): void {
  if (GLOBAL) throw notFound();
}

/** The server-function guard of {@link kubernetesOnlyRoute}. */
export const kubernetesOnly = createMiddleware({ type: 'function' }).server(({ next }) => {
  if (GLOBAL) throw notFound();
  return next();
});
