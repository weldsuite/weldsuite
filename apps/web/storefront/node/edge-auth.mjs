// The edge check of lib/edge-auth.ts for node/server.mjs, which runs without
// the app's TypeScript: the same constant-time compare of SHA-256 digests.
// Keep the two in step (lib/edge-auth.test.ts tests both).

import { createHash, timingSafeEqual } from 'node:crypto'

export const EDGE_HEADER = 'x-storefront-edge'

/**
 * @param {string | string[] | undefined | null} presented the header's value
 * @param {string | undefined} secret STOREFRONT_RENDERER_SECRET
 * @returns {boolean}
 */
export function isEdgeSecret(presented, secret) {
  if (!secret || typeof presented !== 'string' || presented === '') return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

/** @param {string} pathname */
export function isOpenPath(pathname) {
  return pathname === '/healthz'
}
