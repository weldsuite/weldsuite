/**
 * The build-time switch for the runtime config (`/config.json`,
 * `lib/runtime-config.ts`): `VITE_RUNTIME_CONFIG`.
 *
 * - unset or `off`: **Global** (Cloudflare Pages, `weldsuite-test` and
 *   `weldsuite`). No `/config.json` request, the build-time `VITE_*` values
 *   only, and the app is in the entry chunk: nothing waits on an extra round
 *   trip before it starts (`./global.tsx`).
 * - `on`: the **Kubernetes** editions (EU, self-hosted). `/config.json` is
 *   fetched before the app is imported, and picks the identity provider
 *   (`./runtime.tsx`).
 *
 * `vite.config.ts` resolves the `@boot` import in `src/main.tsx` to one of the
 * two files, so a Global bundle holds no runtime-config boot and no OIDC
 * client. The Pages deploys must not set the variable. The Kubernetes build
 * (the `spa` stage of `rust/Dockerfile`, served by the Rust image) sets it.
 *
 * No dependencies: `vite.config.ts` imports this file.
 */

export type BootMode = 'global' | 'runtime';

/** `on` (any case, surrounding spaces ignored) turns it on; anything else is Global. */
export function isRuntimeConfigOn(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase() === 'on';
}

export function bootMode(value: string | undefined | null): BootMode {
  return isRuntimeConfigOn(value) ? 'runtime' : 'global';
}

/**
 * `index.html` without its Google Fonts stylesheet and preconnects, for the
 * Kubernetes builds (`vite.config.ts`): loading them sends every visitor's IP
 * address to Google, which the EU and self-hosted editions must not do. The
 * app then falls back to the system font stack (`app/globals.css`) until
 * Inter and Outfit are self-hosted.
 */
export function withoutGoogleFonts(html: string): string {
  return html.replace(/^[ \t]*<link\b[^>]*\bfonts\.(?:googleapis|gstatic)\.com\b[^>]*>[ \t]*\r?\n/gm, '');
}
