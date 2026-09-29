'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Lets a real module run unauthenticated under a `/preview/*` mirror of its
 * routes, for help-doc screenshots and support videos.
 *
 * Inside the provider:
 * - `usePathname()` reports the path without `basePath`, so module code
 *   (sidebars, active states, URL parsing) sees the path it expects.
 * - `useRouter()` / `<Link>` prefix internal hrefs with `basePath`, so
 *   navigation stays inside the preview instead of hitting auth-gated routes.
 * - The app-api client sends `token` instead of a Clerk session token, so
 *   requests go out and can be answered by fixtures (Playwright `page.route`).
 *
 * Only mounted by `/preview/*` routes; everywhere else the context is null and
 * behaviour is unchanged.
 */
export interface PreviewMode {
  basePath: string;
  token: string;
}

const PreviewModeContext = createContext<PreviewMode | null>(null);

export function PreviewModeProvider({
  value,
  children,
}: Readonly<{ value: PreviewMode; children: ReactNode }>) {
  return <PreviewModeContext.Provider value={value}>{children}</PreviewModeContext.Provider>;
}

export function usePreviewMode() {
  return useContext(PreviewModeContext);
}

/** `/weldmail/x` → `/preview/weldmail/x` (idempotent; external/relative hrefs untouched). */
export function toPreviewHref(mode: PreviewMode | null, href: string): string {
  if (!mode || !href.startsWith('/') || href.startsWith('//')) return href;
  if (href === mode.basePath || href.startsWith(`${mode.basePath}/`)) return href;
  return `${mode.basePath}${href}`;
}

/** `/preview/weldmail/x` → `/weldmail/x`. */
export function fromPreviewPath(mode: PreviewMode | null, pathname: string): string {
  if (!mode) return pathname;
  if (pathname === mode.basePath) return '/';
  if (pathname.startsWith(`${mode.basePath}/`)) return pathname.slice(mode.basePath.length);
  return pathname;
}
