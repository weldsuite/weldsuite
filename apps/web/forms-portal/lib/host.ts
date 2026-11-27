/**
 * The host a respondent reached the portal on. On a workspace's custom domain
 * (EU and self-hosted) forms-api answers only that workspace's forms, so the
 * portal names the host on every call and keeps what it caches per host.
 */

/** The host name of a request, lower case, without port; null when the URL doesn't parse. */
export function requestHost(request: Pick<Request, 'url'>): string | null {
  try {
    return new URL(request.url).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** The cache key of a form on the host it was asked for on. */
export function formCacheKey(host: string | null, publicId: string): string {
  return `${host ?? ''}|${publicId}`
}
