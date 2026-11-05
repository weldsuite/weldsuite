import type { ReactNode } from 'react';
import { Link, useParams, usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';

/** One pill of a sub-nav: `path` is relative to the section's base path, '' for the section root. */
export interface SubNavItem {
  id: string;
  label: string;
  path: string;
}

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/**
 * The pill a pathname belongs to: the exact path, else the pill whose path is a
 * parent of it (a detail page under a register), else the section root.
 */
export function activeSubNavId(pathname: string, basePath: string, items: readonly SubNavItem[]): string {
  const rest = pathname.startsWith(basePath) ? trimTrailingSlashes(pathname.slice(basePath.length)) : '';
  const exact = items.find((item) => item.path === rest);
  if (exact) return exact.id;
  const parent = items.find((item) => item.path !== '' && rest.startsWith(`${item.path}/`));
  return (parent ?? items.find((item) => item.path === '') ?? items[0]).id;
}

/** The pill row every WeldFlow section with sub-pages shares (same look as the RAID log's). */
export function SubNavPills({
  label,
  basePath,
  items,
  activeId,
  className,
}: Readonly<{ label: string; basePath: string; items: readonly SubNavItem[]; activeId: string; className?: string }>) {
  return (
    <nav aria-label={label} className={cn('flex gap-1.5 overflow-x-auto pb-2.5', className)}>
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <Link
            key={item.id}
            href={`${basePath}${item.path}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'bg-foreground font-medium text-background' : 'text-foreground/80 hover:bg-accent',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A project tab that holds sub-pages: the pills on top, the active sub-page
 * under them. A sub-page whose id is `fullBleedId` lays itself out (the Gantt
 * chart); every other one gets the padded, scrolling content area the RAID log uses.
 */
export function ProjectSubNavLayout({
  section,
  label,
  items,
  fullBleedId,
  children,
}: Readonly<{ section: string; label: string; items: readonly SubNavItem[]; fullBleedId?: string; children: ReactNode }>) {
  const params = useParams();
  const pathname = usePathname();
  const basePath = `/weldflow/project/${params.projectId as string}/${section}`;
  const activeId = activeSubNavId(pathname, basePath, items);
  const fullBleed = activeId === fullBleedId;
  return (
    <div className="flex h-full min-h-0 flex-col pt-3">
      <SubNavPills label={label} basePath={basePath} items={items} activeId={activeId} className="px-3 md:px-4" />
      <div
        className={cn(
          'min-h-0 flex-1',
          fullBleed ? 'flex flex-col' : 'overflow-y-auto px-3 pt-1 pb-8 md:px-4',
        )}
      >
        {children}
      </div>
    </div>
  );
}
