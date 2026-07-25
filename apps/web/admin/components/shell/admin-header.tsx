'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@weldsuite/ui/components/breadcrumb';
import { SidebarTrigger } from '@weldsuite/ui/components/sidebar';
import { getActiveArea } from './nav-config';

interface Crumb {
  label: string;
  href?: string;
}

/** `app-catalog` → `App Catalog`; ids are left alone. */
function humanize(segment: string): string {
  const decoded = decodeURIComponent(segment);
  if (/^[a-z]{2,6}_[A-Za-z0-9]{8,}$/.test(decoded)) return decoded; // prefixed id
  return decoded
    .split('-')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function buildCrumbs(pathname: string, areaName: string, areaHref: string): Crumb[] {
  if (pathname === '/') return [{ label: 'Overview' }];

  const segments = pathname.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ label: areaName, href: areaHref }];

  // The first segment is the area itself — already the root crumb.
  const areaSegments = areaHref.split('/').filter(Boolean).length;
  for (let i = areaSegments; i < segments.length; i++) {
    const href = `/${segments.slice(0, i + 1).join('/')}`;
    crumbs.push({ label: humanize(segments[i]!), href });
  }

  const last = crumbs[crumbs.length - 1];
  if (last) delete last.href;
  return crumbs;
}

/**
 * Slim app-level header — mirrors the platform's `AppHeader`: sidebar trigger,
 * hairline divider, then the breadcrumb trail, all on the panel surface so the
 * header reads as part of the content card rather than a separate bar.
 */
export function AdminHeader({ actions }: { actions?: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const area = getActiveArea(pathname);
  const crumbs = buildCrumbs(pathname, area.name, area.href);

  return (
    <header
      data-slot="app-header"
      className="sticky top-0 z-40 flex h-[60px] shrink-0 items-center bg-[var(--shell-panel)]"
    >
      <div className="relative z-10 flex w-full items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <div className="ml-px mr-[8px] h-[19px] w-px shrink-0 bg-gray-200/70 dark:bg-secondary/70" />

        <Breadcrumb className="overflow-hidden">
          <BreadcrumbList>
            {crumbs.map((crumb, i) => (
              <React.Fragment key={`${crumb.label}-${i}`}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {crumb.href ? (
                    <BreadcrumbLink asChild>
                      <Link href={crumb.href}>{crumb.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>

        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
