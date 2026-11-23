/**
 * The renderer answers only the storefront edge (the Rust server), which
 * sends `X-Storefront-Edge: <STOREFRONT_RENDERER_SECRET>` with every request.
 * Anything else gets a 404, as if nothing were here; `/healthz` is the one
 * exception (the probes). node/server.mjs does the same check before it
 * serves a static file; keep the two in step (edge-auth.test.ts tests both).
 */

export const EDGE_HEADER = 'x-storefront-edge';

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/**
 * Whether `presented` is the secret, compared in constant time: both sides
 * are hashed first, so neither the length nor the first differing byte shows
 * in the timing.
 */
export async function isEdgeSecret(presented: string | null | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret || !presented) return false;
  const [a, b] = await Promise.all([digest(presented), digest(secret)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

/** Paths answered without the edge's header. */
export function isOpenPath(pathname: string): boolean {
  return pathname === '/healthz';
}

/** The plain 404 every refused request gets (no hint that a renderer is here). */
export function refusal(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
