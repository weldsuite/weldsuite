/**
 * Reads route matches and renders the breadcrumb trail.
 * Kept separate from <AppHeader/> so re-renders are scoped to navigation,
 * not to drawer toggles or palette state.
 *
 * Prefer `BreadcrumbProvider` segments when a module layout supplies them
 * (e.g. hosted WeldApps); otherwise derive from TanStack route matches.
 */

import { Fragment, useEffect, useMemo } from 'react';
import { useMatches, Link } from '@tanstack/react-router';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@weldsuite/ui/components/breadcrumb';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  buildBreadcrumbSegments,
  collapseLongTrail,
  type BreadcrumbSegment,
  type MatchLike,
} from '@/lib/breadcrumbs/build-segments';
import { useFallbackLabelRegistry } from './app-header-fallback-registry';
import { useCurrentBreadcrumbsMaybe } from '@/contexts/breadcrumb-context';

interface AppHeaderTrailHandle {
  hideAll: boolean;
}

interface AppHeaderTrailProps {
  onResolved?: (handle: AppHeaderTrailHandle) => void;
}

export function AppHeaderTrail({ onResolved }: AppHeaderTrailProps) {
  const matches = useMatches();
  const registry = useFallbackLabelRegistry();
  const providerCrumbs = useCurrentBreadcrumbsMaybe();

  const { segments, hideAll } = useMemo(() => {
    if (providerCrumbs && providerCrumbs.length > 0) {
      const fromProvider: BreadcrumbSegment[] = providerCrumbs.map((seg) => ({
        label: seg.label,
        href: seg.href ?? '#',
        pending: false,
        source: 'static' as const,
      }));
      return { segments: fromProvider, hideAll: false };
    }

    const matchLike: MatchLike[] = matches.map((m) => ({
      pathname: m.pathname,
      status: m.status as MatchLike['status'],
      staticData: m.staticData as MatchLike['staticData'],
      loaderData: m.loaderData as MatchLike['loaderData'],
    }));
    return buildBreadcrumbSegments(matchLike, registry);
  }, [matches, registry, providerCrumbs]);

  useEffect(() => {
    onResolved?.({ hideAll });
  }, [onResolved, hideAll]);

  if (hideAll || segments.length === 0) return null;

  const { visible, ellipsis } = collapseLongTrail(segments, 4);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {ellipsis ? (
          <>
            {visible[0] && (
              <Fragment key={`first-${visible[0].href}`}>
                <BreadcrumbItem>
                  <SegmentLink seg={visible[0]} />
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </Fragment>
            )}
            <BreadcrumbItem>
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            {visible.slice(1).map((seg, i, arr) => {
              const isLast = i === arr.length - 1;
              return (
                <Fragment key={`mid-${seg.href}`}>
                  <BreadcrumbItem className="max-w-[180px] truncate">
                    {isLast ? <SegmentPage seg={seg} /> : <SegmentLink seg={seg} />}
                  </BreadcrumbItem>
                  {!isLast && <BreadcrumbSeparator />}
                </Fragment>
              );
            })}
          </>
        ) : (
          visible.map((seg, i) => {
            const isLast = i === visible.length - 1;
            return (
              <Fragment key={`seg-${seg.href}`}>
                <BreadcrumbItem className="max-w-[200px] truncate">
                  {isLast ? <SegmentPage seg={seg} /> : <SegmentLink seg={seg} />}
                </BreadcrumbItem>
                {!isLast && <BreadcrumbSeparator />}
              </Fragment>
            );
          })
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function SegmentLink({ seg }: { seg: ReturnType<typeof collapseLongTrail>['visible'][number] }) {
  if (seg.pending) {
    return (
      <span
        data-testid="breadcrumb-skeleton"
        className="inline-block w-20 h-4 rounded bg-muted animate-pulse"
        aria-busy="true"
      />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <BreadcrumbLink asChild>
          <Link to={seg.href} className="truncate">
            {seg.icon ? <seg.icon className="h-4 w-4 mr-1 inline-block align-text-bottom" /> : null}
            {seg.label}
          </Link>
        </BreadcrumbLink>
      </TooltipTrigger>
      <TooltipContent>{seg.label}</TooltipContent>
    </Tooltip>
  );
}

function SegmentPage({ seg }: { seg: ReturnType<typeof collapseLongTrail>['visible'][number] }) {
  if (seg.pending) {
    return (
      <span
        data-testid="breadcrumb-skeleton"
        className="inline-block w-20 h-4 rounded bg-muted animate-pulse"
        aria-busy="true"
      />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <BreadcrumbPage className="truncate font-medium">
          {seg.icon ? <seg.icon className="h-4 w-4 mr-1 inline-block align-text-bottom" /> : null}
          {seg.label}
        </BreadcrumbPage>
      </TooltipTrigger>
      <TooltipContent>{seg.label}</TooltipContent>
    </Tooltip>
  );
}
