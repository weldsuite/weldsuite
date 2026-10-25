import { getRouteApi } from '@tanstack/react-router'
import type { SiteData } from '@/lib/api-client'

const rootRoute = getRouteApi('__root__')

/** The site data the root route loaded (branding, folders, locale). */
export function useSite(): SiteData {
  return rootRoute.useLoaderData()
}

/**
 * `<page> - <site name>` for a child route's `head()`, which only sees its own
 * loader data directly; the root match carries the site's.
 */
export function pageTitle(
  matches: ReadonlyArray<{ routeId: string; loaderData?: unknown }>,
  title: string,
): string {
  const site = matches.find((m) => m.routeId === '__root__')?.loaderData as SiteData | undefined
  return `${title} - ${site?.config.siteName || 'Help Center'}`
}
