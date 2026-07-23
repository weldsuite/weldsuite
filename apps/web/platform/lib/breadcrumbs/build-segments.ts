/**
 * Pure builder that turns a route-match array into the breadcrumb trail.
 *
 * Inputs are normalized so this is unit-testable without any TanStack runtime.
 * Resolution order per match:
 *   1. loaderData.breadcrumbLabel — set by route loaders for dynamic entities
 *   2. staticData.breadcrumb.label — explicit static label
 *   3. fallback from a path-segment label registry (for unmigrated routes)
 *
 * `hidden` removes the segment from the trail. `hideAll` short-circuits the
 * entire header — the AppHeader returns null when ANY match has `hideAll`.
 */

import type { BreadcrumbDescriptor, BreadcrumbLoaderData } from './types';
import type { ComponentType } from 'react';

export interface MatchLike {
  pathname: string;
  status?: 'pending' | 'success' | 'error' | 'notFound' | 'redirected';
  staticData?: { breadcrumb?: BreadcrumbDescriptor } | undefined;
  loaderData?: BreadcrumbLoaderData | undefined;
}

export interface BreadcrumbSegment {
  label: string;
  href: string;
  icon?: ComponentType<{ className?: string }>;
  pending: boolean;
  source: 'loader' | 'static' | 'fallback';
}

export interface BuildBreadcrumbsResult {
  segments: BreadcrumbSegment[];
  hideAll: boolean;
}

/**
 * Map a path segment ("contacts") to a human label ("Contacts").
 * Used only for routes that haven't migrated to the new system yet.
 */
function defaultLabelFor(pathname: string, fallbackRegistry: Map<string, string>): string {
  const fromRegistry = fallbackRegistry.get(pathname);
  if (fromRegistry) return fromRegistry;
  // Last segment, title-cased; skip ID-like segments (UUIDs, prefixed IDs like cont_xxx)
  const parts = pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return '';
  if (isIdLike(last)) return '';
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function isIdLike(seg: string): boolean {
  // Drizzle-style IDs: shortprefix_xxxxx, or a UUID
  if (/^[a-z]{2,8}_[a-z0-9]{6,}$/i.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^[0-9]{6,}$/.test(seg)) return true;
  return false;
}

export function buildBreadcrumbSegments(
  matches: readonly MatchLike[],
  fallbackRegistry: Map<string, string> = new Map(),
): BuildBreadcrumbsResult {
  const segments: BreadcrumbSegment[] = [];
  let hideAll = false;

  for (const match of matches) {
    const descriptor = match.staticData?.breadcrumb;
    if (descriptor?.hideAll) {
      hideAll = true;
      continue;
    }
    if (descriptor?.hidden) continue;

    const loaderLabel = match.loaderData?.breadcrumbLabel;
    const isPending = match.status === 'pending';

    let label: string | undefined;
    let source: BreadcrumbSegment['source'] = 'fallback';

    if (loaderLabel && loaderLabel.trim()) {
      label = loaderLabel.trim();
      source = 'loader';
    } else if (descriptor?.label) {
      label = descriptor.label;
      source = 'static';
    } else {
      // No descriptor yet, fall back to segment-name heuristics
      const fallback = defaultLabelFor(match.pathname, fallbackRegistry);
      if (fallback) {
        label = fallback;
        source = 'fallback';
      }
    }

    if (!label) continue; // skip — no usable label (e.g. ID segment with no descriptor)

    const href = descriptor?.href ?? match.pathname;
    segments.push({
      label,
      href,
      icon: descriptor?.icon,
      pending: isPending && source !== 'static',
      source,
    });
  }

  // Collapse duplicate consecutive labels (can happen when a child index route
  // falls back to the same path-segment name that its parent route already
  // set via staticData, or when a child loader resolves to the parent label).
  const collapsed: BreadcrumbSegment[] = [];
  for (const seg of segments) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.label === seg.label) continue;
    collapsed.push(seg);
  }

  return { segments: collapsed, hideAll };
}

/**
 * Truncate the middle when there are too many segments. Keeps the first and
 * the last 2 segments and inserts a sentinel ellipsis between.
 */
export function collapseLongTrail(
  segments: BreadcrumbSegment[],
  maxVisible = 4,
): { visible: BreadcrumbSegment[]; ellipsis: boolean } {
  if (segments.length <= maxVisible) {
    return { visible: segments, ellipsis: false };
  }
  return {
    visible: [segments[0], ...segments.slice(-2)],
    ellipsis: true,
  };
}
