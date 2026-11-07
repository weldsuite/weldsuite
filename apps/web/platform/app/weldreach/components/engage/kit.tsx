/**
 * Building blocks shared by the WeldReach campaign, prospect and inbox pages.
 * They follow the platform conventions (see `app/weldhr/components/page-kit.tsx`):
 * lists are a `PanelEntityList` with the breadcrumb as the title, the campaign
 * page uses WeldConnect's `EditorWizardNav` (`@/components/editor-wizard-nav`),
 * loading is `PageLoader` / `InlineSpinner`, failures are `ErrorBanner`,
 * notices are `InfoBanner`, confirmations use `ConfirmDialog` and list filters
 * use `FilterSelect` (all from `@weldsuite/ui`).
 */

import type { ComponentType } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useBreadcrumbs, type BreadcrumbSegment } from '@/contexts/breadcrumb-context';

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Set the AppHeader breadcrumb trail. `useBreadcrumbs` replaces the whole
 * trail, so this prepends the WeldReach root to every page.
 */
export function useReachBreadcrumbs(
  ...segments: Array<BreadcrumbSegment | null | undefined | false>
) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('reach.title'), href: '/weldreach' },
    ...segments.filter((segment): segment is BreadcrumbSegment => Boolean(segment)),
  ]);
}

// ---------------------------------------------------------------------------
// Lists and empty states
// ---------------------------------------------------------------------------

/** The empty-state icon every EntityList page uses. */
export function emptyIcon(Icon: ComponentType<{ className?: string; strokeWidth?: number }>) {
  return (
    <EmptyStateIllustration>
      <Icon className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
    </EmptyStateIllustration>
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** A server message without its closing full stop, to embed in a longer sentence. */
export function withoutTrailingPeriod(message: string): string {
  let end = message.length;
  while (end > 0 && (message[end - 1] === '.' || message[end - 1] === ' ')) end -= 1;
  return message.slice(0, end);
}

