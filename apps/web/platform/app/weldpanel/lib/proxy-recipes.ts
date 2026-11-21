/**
 * Reverse-proxy recipes for the install page: a copy of `proxyRecipe` in
 * `@weldsuite/panel-sdk/install` (the platform does not depend on the SDK
 * package). `proxy-recipes.test.ts` compares the two, so a change there
 * fails here until it is copied over.
 */

/** The collector, which also serves the snippet. */
export const DEFAULT_HOST = 'https://pnl.weldsuite.org';

/** `https://pnl.weldsuite.org///` → `https://pnl.weldsuite.org`, without a backtracking regex. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

// ---------------------------------------------------------------------------
// Reverse proxy recipes
// ---------------------------------------------------------------------------
//
// Ad blockers block requests to analytics hosts; requests to the site's own
// domain go through. Each recipe forwards `<path>/*` on the site to the
// collector, sends the visitor's address as the first `X-Forwarded-For` hop
// (the collector uses it for the cookieless visitor id, IP filters and rate
// limits, and never stores it) and, where the proxy knows it, the visitor's
// country, region and city as `X-WeldPanel-Country` / `-Region` / `-City`
// (Vercel's own `x-vercel-ip-*` headers are read too). Cookies are not
// forwarded. The snippet then loads `<path>/s.js`, which sends to the same
// origin by itself.

/** The path recipes use unless told otherwise. Short and neutral, so block lists don't match it. */
export const DEFAULT_PROXY_PATH = '/wp';

export type ProxyRecipeKind = 'nextjs' | 'vercel' | 'cloudflare-worker' | 'nginx';

export interface ProxyRecipeOptions {
  /** Where the proxy lives on the site, `/wp` by default. */
  path?: string;
  /** The collector, `https://pnl.weldsuite.org` by default. */
  collector?: string;
}

function proxyPath(path: string | undefined): string {
  const trimmed = trimTrailingSlashes((path || DEFAULT_PROXY_PATH).trim());
  return trimmed.charAt(0) === '/' ? trimmed : `/${trimmed}`;
}

/** The recipe for one kind of proxy, as text to show or copy. */
export function proxyRecipe(kind: ProxyRecipeKind, options: ProxyRecipeOptions = {}): string {
  const path = proxyPath(options.path);
  const collector = trimTrailingSlashes(options.collector || DEFAULT_HOST);
  const collectorHost = collector.replace(/^https?:\/\//, '');
  switch (kind) {
    case 'nextjs':
      return [
        '// next.config.js (or .mjs / .ts): forward the collector through your own domain.',
        '// On Vercel the visitor\'s address (X-Forwarded-For) and the x-vercel-ip-* geo headers come along;',
        '// on your own server, put X-WeldPanel-Country / -Region / -City on the request if your CDN knows them.',
        'module.exports = {',
        '  async rewrites() {',
        `    return [{ source: '${path}/:path*', destination: '${collector}/:path*' }];`,
        '  },',
        '  // Keeps /wp/e from being redirected to /wp/e/.',
        '  skipTrailingSlashRedirect: true,',
        '};',
      ].join('\n');
    case 'vercel':
      return [
        '{',
        '  "rewrites": [',
        `    { "source": "${path}/:path*", "destination": "${collector}/:path*" }`,
        '  ]',
        '}',
      ].join('\n');
    case 'cloudflare-worker':
      return [
        `// A Worker on a route of your site, e.g. example.com${path}/*`,
        'export default {',
        '  async fetch(request) {',
        '    const url = new URL(request.url);',
        `    const target = new URL(url.pathname.slice(${path.length}) + url.search, '${collector}');`,
        '    const headers = new Headers(request.headers);',
        "    headers.delete('Cookie');",
        "    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');",
        '    const cf = request.cf || {};',
        "    if (cf.country) headers.set('X-WeldPanel-Country', cf.country);",
        "    if (cf.region) headers.set('X-WeldPanel-Region', encodeURIComponent(cf.region));",
        "    if (cf.city) headers.set('X-WeldPanel-City', encodeURIComponent(cf.city));",
        "    return fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' });",
        '  },',
        '};',
      ].join('\n');
    case 'nginx':
      return [
        `location ${path}/ {`,
        `    proxy_pass ${collector}/;`,
        `    proxy_set_header Host ${collectorHost};`,
        '    proxy_ssl_server_name on;',
        '    # The visitor\'s own address as the first hop (not $proxy_add_x_forwarded_for, which keeps what the browser sent).',
        '    proxy_set_header X-Forwarded-For $remote_addr;',
        '    proxy_set_header Cookie "";',
        '    # With the GeoIP2 module, the visitor\'s location:',
        '    # proxy_set_header X-WeldPanel-Country $geoip2_data_country_code;',
        '    # proxy_set_header X-WeldPanel-City $geoip2_data_city_name;',
        '}',
      ].join('\n');
  }
}

/** Every recipe with the default path and collector, for docs. */
export const PROXY_RECIPES: Readonly<Record<ProxyRecipeKind, string>> = {
  nextjs: proxyRecipe('nextjs'),
  vercel: proxyRecipe('vercel'),
  'cloudflare-worker': proxyRecipe('cloudflare-worker'),
  nginx: proxyRecipe('nginx'),
};
