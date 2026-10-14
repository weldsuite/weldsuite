/**
 * Test stand-in for the Workers-only `cloudflare:sockets` module (aliased in
 * vitest.config.ts).
 *
 * `@weldsuite/smtp` opens its connection through `connect`; WeldReach's reply
 * route reaches it through `@weldsuite/reach-domain`. Nothing in the worker
 * passes a socket factory, so a test installs one here (a scripted fake SMTP
 * server) and the real send path runs against it. With none installed, connecting
 * fails like the smtp package's own stub, which the client reports as a failed
 * send, never as a real connection.
 */

/** `never` parameters: any function over the smtp package's address/options types is assignable, and this file imports nothing from it. */
type SocketFactory = (address: never, options: never) => unknown;

let installed: SocketFactory | null = null;

/** Install the factory the next connections use; `null` removes it. Remove it in `afterEach`: the suite shares one module cache. */
export function useSocketFactory(factory: SocketFactory | null): void {
  installed = factory;
}

export function connect(address: { hostname: string; port: number }, options: Record<string, unknown>): unknown {
  if (!installed) throw new Error('cloudflare:sockets is not available in tests; install a socket factory');
  return installed(address as never, options as never);
}
