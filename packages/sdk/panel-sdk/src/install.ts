/**
 * The install snippet, for the WeldPanel install page and docs. Kept here so
 * the stub and the loader that replays it (./snippet.ts) change together.
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
  'p.track=s("track");p.optOut=s("optOut");p.optIn=s("optIn");p.flush=s("flush");' +
  'p.consent={grant:s("consent.grant"),revoke:s("consent.revoke")}}(window);';

const attr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The HTML to paste before `</head>`: the stub, then the async loader. */
export function installSnippet(token: string, host: string = DEFAULT_HOST): string {
  const origin = trimTrailingSlashes(host);
  return `<script>${STUB}</script>\n<script async src="${attr(origin)}/s.js" data-project="${attr(token)}"></script>`;
}
