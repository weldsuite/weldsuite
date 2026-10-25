/**
 * Edge cache in front of slow-changing responses, standing in for Next's ISR:
 * a hit is served from the colo's cache until `ttl` seconds after it was
 * stored, then the next request rebuilds it. `ttl <= 0` bypasses the cache.
 *
 * The Cache API is per colo and does nothing on workers.dev hosts, so a miss
 * there always rebuilds, which is correct, only slower.
 */
export async function cached(
  key: string,
  ttl: number,
  build: () => Promise<Response>,
): Promise<Response> {
  if (ttl <= 0) return build()

  const cache = caches.default
  const hit = await cache.match(key)
  // Cached responses have immutable headers; hand out a copy that callers
  // (and the security-headers middleware) can still add to.
  if (hit) return new Response(hit.body, hit)

  const res = await build()
  if (!res.ok) return res

  // Store a copy whose Cache-Control sets the TTL; return the original.
  const stored = new Response(res.clone().body, res)
  stored.headers.set('Cache-Control', `public, max-age=${ttl}`)
  await cache.put(key, stored)
  return res
}
