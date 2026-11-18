/**
 * The install snippet and the reverse-proxy recipes, for the WeldPanel install
 * page and docs. Kept here so the stub and the loader that replays it
 * (./snippet.ts) change together, and so the install page and the docs show
 * the same recipes.
 *
 * The Rust backend has its own copy of {@link STUB} and {@link installSnippet}
 * (rust/modules/panel/src/domain.rs): panel-api's project DTO carries the
 * snippet, and both backends must answer it alike.
 */

import { DEFAULT_HOST, trimTrailingSlashes } from './host';

export { DEFAULT_HOST, trimTrailingSlashes };

/**
 * Defines `window.weldpanel` before the script has loaded, queueing calls in
 * `weldpanel.q` as `[method, args]` for the loader to replay. Does nothing
 * when the SDK is already there.
 */
export const STUB =
  '!function(w,p,s){p=w.weldpanel=w.weldpanel||{q:[]};if(!p.q)return;' +
  's=function(n){return function(){p.q.push([n,[].slice.call(arguments)])}};' +
  'p.track=s("track");p.identify=s("identify");p.reset=s("reset");p.optOut=s("optOut");p.optIn=s("optIn");p.flush=s("flush");' +
  'p.register=s("register");p.registerOnce=s("registerOnce");p.unregister=s("unregister");p.group=s("group");p.resetGroups=s("resetGroups");' +
  'p.consent={grant:s("consent.grant"),revoke:s("consent.revoke")};' +
  'p.people={set:s("people.set"),set_once:s("people.set_once"),unset:s("people.unset"),increment:s("people.increment")};' +
  'p.groups={set:s("groups.set"),set_once:s("groups.set_once"),unset:s("groups.unset")}}(window);';

const attr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface SnippetOptions {
  /** Send events here instead of to the script's origin: a reverse proxy on the site's own domain (`/wp` or `https://example.com/wp`). */
  apiHost?: string;
}

/** The HTML to paste before `</head>`: the stub, then the async loader. */
export function installSnippet(token: string, host: string = DEFAULT_HOST, options: SnippetOptions = {}): string {
  const origin = trimTrailingSlashes(host);
  const apiHost = options.apiHost ? ` data-api-host="${attr(trimTrailingSlashes(options.apiHost))}"` : '';
  return `<script>${STUB}</script>\n<script async src="${attr(origin)}/s.js" data-project="${attr(token)}"${apiHost}></script>`;
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
