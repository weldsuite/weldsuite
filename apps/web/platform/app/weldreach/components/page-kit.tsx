/**
 * WeldReach page building blocks shared by every screen of the module
 * (overview, setup, mailboxes, settings, and the campaign, prospect and inbox
 * pages). The page shells, KPI tiles, section cards and the empty / error
 * states come from the component library (`@weldsuite/ui`: `page-layout`,
 * `kpi-card`, `section-card`, `empty-state`, `error-banner`); this file holds
 * what is WeldReach's own.
 */

import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs, type BreadcrumbSegment } from '@/contexts/breadcrumb-context';

/**
 * Set the AppHeader breadcrumb trail. `useBreadcrumbs` replaces the whole
 * trail, so this prepends the WeldReach root for every page.
 */
export function useReachBreadcrumbs(...segments: Array<BreadcrumbSegment | null | undefined | false>) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('reach.title'), href: '/weldreach' },
    ...segments.filter((segment): segment is BreadcrumbSegment => Boolean(segment)),
  ]);
}
