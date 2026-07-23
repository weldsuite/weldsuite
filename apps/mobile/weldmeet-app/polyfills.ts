/**
 * Web-API polyfills required by @cloudflare/realtimekit-react-native.
 *
 * The realtimekit-react-native package's own entry point imports these
 * polyfills, BUT it imports `@cloudflare/realtimekit` (the parent package)
 * on its very first line — before the polyfill side-effect imports. The
 * parent package's bundle calls `new TextDecoder().decode(...)` and
 * `atob(...)` at module-evaluation time, which crashes with
 * "Cannot read property 'decode' of undefined" if the polyfills haven't
 * been registered yet.
 *
 * We work around it by importing the polyfills here and pulling this
 * module in as the very first import of `app/_layout.tsx` — that
 * guarantees `globalThis.TextDecoder` / `atob` / `URL` are wired before
 * any realtimekit module is evaluated.
 */

import 'text-encoding-polyfill';
import 'react-native-url-polyfill/auto';
import { decode as base64Decode, encode as base64Encode } from 'base-64';

// Hermes lacks atob/btoa. realtimekit-react-native's own entry sets these,
// but only once it gets a chance to run — see the file-level comment.
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = base64Decode;
}
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = base64Encode;
}

// One-shot diagnostic so it's obvious from the Metro log whether this file
// ran before the realtimekit modules. Remove once stable.
console.log('[polyfills] loaded:', {
  TextDecoder: typeof globalThis.TextDecoder,
  TextEncoder: typeof globalThis.TextEncoder,
  atob: typeof globalThis.atob,
  btoa: typeof globalThis.btoa,
  URL: typeof globalThis.URL,
});
