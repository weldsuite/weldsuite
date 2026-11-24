/**
 * Build-time choices, read from the Vite env. The store build sets none of
 * them: it serves `https://app.weldsuite.eu` and its issuer.
 *
 * - `VITE_DEFAULT_SERVER`, `VITE_DEFAULT_ISSUER`: another default server, for
 *   a development build against EU test (`https://app.test.weldsuite.eu`,
 *   `https://auth.test.weldsuite.eu`) or a local backend. The manifest grants
 *   host access to exactly these two. Both https, or http://localhost.
 * - `VITE_EXTENSION_KEY`: the public key that pins the extension id
 *   (`manifest.key`). Development and test builds only: the Chrome Web Store
 *   refuses a manifest with a key.
 */

import { EU_SERVER, secureOrigin, type DefaultServer } from './origins';

export function defaultServerFrom(env: Record<string, string | undefined>): DefaultServer {
  const origin = secureOrigin(env.VITE_DEFAULT_SERVER);
  const issuer = secureOrigin(env.VITE_DEFAULT_ISSUER);
  if (!origin) return EU_SERVER;
  // A custom server without an issuer: the issuer's host permission is asked
  // for at run time, like a self-hosted server's.
  return { origin, issuer: issuer ?? origin };
}
