/**
 * The worker's HTTP endpoints carry no auth, so they answer service bindings
 * only. A service-binding call carries whatever URL the caller built
 * (`https://helpdesk-workflow-worker/respond`); a request from the internet
 * always has a real hostname: a custom domain left attached from before, or
 * `*.workers.dev`. Local `wrangler dev` (localhost) stays reachable.
 */
export function isPublicHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false;
  return hostname.includes('.');
}
