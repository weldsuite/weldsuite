/**
 * A browser that marks the request same-origin (`Sec-Fetch-Site`), or whose
 * `Origin` names this host. Requests with neither are refused: everything
 * that changes something in the console is a request from its own pages.
 */
export function isSameSiteRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';

  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const host = request.headers.get('host') ?? new URL(request.url).host;
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
