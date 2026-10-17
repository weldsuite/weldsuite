import type { ComponentType } from 'react';
import type { TranslationsType } from '@/lib/i18n/types';

/** Key into `navigation.breadcrumbs` in the i18n locales. */
export type BreadcrumbLabelKey = keyof TranslationsType['navigation']['breadcrumbs'];

/**
 * Per-route breadcrumb metadata declared on `staticData.breadcrumb`.
 *
 * Three forms:
 *  - `{ label: 'Contacts' }` — fixed label
 *  - `{ labelKey: 'contacts' }` — fixed label, translated via `navigation.breadcrumbs`
 *  - omit and provide a `loader` returning `{ breadcrumbLabel }` — dynamic
 *  - `{ hidden: true }` — passthrough segment (still routed, no crumb shown)
 *  - `{ hideAll: true }` — full-screen route, hide the entire header
 */
export interface BreadcrumbDescriptor {
  /** Static label. Skip and use loader for dynamic. */
  label?: string;
  /** Translated static label (`navigation.breadcrumbs.<key>`). Wins over `label` when a resolver is supplied. */
  labelKey?: BreadcrumbLabelKey;
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
