/** Test stub for the Workers-only `cloudflare:sockets` module; tests inject their own socket. */
export function connect(): never {
  throw new Error('cloudflare:sockets is not available in tests; inject a socket factory');
}
