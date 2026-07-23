import type { ComponentType } from 'react';

/**
 * Per-route breadcrumb metadata declared on `staticData.breadcrumb`.
 *
 * Three forms:
 *  - `{ label: 'Contacts' }` — fixed label
 *  - omit and provide a `loader` returning `{ breadcrumbLabel }` — dynamic
 *  - `{ hidden: true }` — passthrough segment (still routed, no crumb shown)
 *  - `{ hideAll: true }` — full-screen route, hide the entire header
 */
export interface BreadcrumbDescriptor {
  /** Static label. Skip and use loader for dynamic. */
  label?: string;
  /** Optional icon for the segment (typically only used at the root). */
  icon?: ComponentType<{ className?: string }>;
  /** Override href; defaults to the route match's pathname. */
  href?: string;
  /** Hide this segment in the trail (route still matches). */
  hidden?: boolean;
  /** Hide the entire AppHeader for this route (full-screen pages). */
  hideAll?: boolean;
}

/** Loader return shape used by detail routes to resolve entity names. */
export interface BreadcrumbLoaderData {
  breadcrumbLabel?: string;
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    breadcrumb?: BreadcrumbDescriptor;
  }
}
