/**
 * Origins and host permission patterns. No imports: `vite.config.ts` loads
 * this (through `manifest.ts` and `build-config.ts`) under plain Node.
 */

/** What the build defaults to; the manifest grants host access to it and its issuer. */
export interface DefaultServer {
  origin: string;
  issuer: string;
}

export const EU_SERVER: DefaultServer = {
  origin: 'https://app.weldsuite.eu',
  issuer: 'https://auth.weldsuite.eu',
};

/** The origin of an http(s) URL, or null. Only https, or http to localhost. */
export function secureOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.origin;
    if (url.protocol === 'http:' && url.hostname === 'localhost') return url.origin;
    return null;
  } catch {
    return null;
  }
}

/** Host permission match patterns for these origins. A pattern has no port: `http://localhost/*` covers them all. */
export function hostPatternsFor(origins: ReadonlyArray<string | null | undefined>): string[] {
  const patterns = origins
    .map((origin) => {
      const secure = secureOrigin(origin ?? null);
      if (!secure) return null;
      const url = new URL(secure);
      return `${url.protocol}//${url.hostname}/*`;
    })
    .filter((pattern): pattern is string => pattern !== null);
  return [...new Set(patterns)];
}
