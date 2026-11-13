import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ListToolbar, type ListToolbarProps } from '@weldsuite/ui/components/list-toolbar';
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

interface SubNavContextValue {
  label: string;
  basePath: string;
  items: readonly SubNavItem[];
  activeId: string;
  /** Where a sub-page's own toolbar goes (it replaces the plain one). */
  slot: HTMLDivElement | null;
  /** A sub-page with its own toolbar claims the bar while it is mounted. */
  claim: () => () => void;
}

const SubNavContext = createContext<SubNavContextValue | null>(null);

/**
 * The sub-pages as a segmented switch, where the RAID log and My tasks keep
 * theirs in the list toolbar. Links, so a sub-page can be opened in a new tab.
 */
export function SubNavTabs() {
  const context = useContext(SubNavContext);
  if (!context) return null;
  return <SubNavSwitch label={context.label} basePath={context.basePath} items={context.items} activeId={context.activeId} />;
}

/** The segmented switch of `SubNavTabs`, for a page that has its own toolbar (Workload and its views). */
export function SubNavSwitch({
  label,
  basePath,
  items,
  activeId,
}: Readonly<{ label: string; basePath: string; items: readonly SubNavItem[]; activeId: string }>) {
  return (
    <nav aria-label={label} className="inline-flex shrink-0 rounded-md">
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <Link
            key={item.id}
            href={`${basePath}${item.path}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-ml-px inline-flex h-8 items-center whitespace-nowrap border border-input px-3 text-sm outline-none transition-colors first:ml-0 first:rounded-l-md last:rounded-r-md',
              'focus-visible:z-10 focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active
                ? 'bg-accent font-medium text-accent-foreground dark:bg-input/50'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50',
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
 * A sub-page's controls in the bar of its project tab: the standard list
 * toolbar (filters, search, buttons, the create button), with the sub-tabs
 * first. While it is mounted it takes the place of the plain bar.
 */
export function SubNavToolbar({ leftActionButtons, className, ...props }: Readonly<ListToolbarProps>) {
  const context = useContext(SubNavContext);
  const claim = context?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  if (!context?.slot) return null;
  return createPortal(
    <ListToolbar
      {...props}
      leftActionButtons={
        <>
          <SubNavTabs />
          {leftActionButtons}
        </>
      }
      className={cn('shrink-0 pt-2 pb-2', className)}
    />,
    context.slot,
  );
}

/**
 * A project tab that holds sub-pages: the standard list toolbar on top, with
 * the sub-tabs on its left (a sub-page adds its own controls through
 * `SubNavToolbar`), and the active sub-page under it.
 *
 * Layout of the sub-page: `fullBleedId` lays itself out (the Gantt chart);
 * `flushIds` scroll edge to edge (lists and panels meet the borders); every
 * other one gets the padded, scrolling content area.
 */
export function ProjectSubNavLayout({
  section,
  label,
  items,
  fullBleedId,
  flushIds,
  children,
}: Readonly<{
  section: string;
  label: string;
  items: readonly SubNavItem[];
  fullBleedId?: string;
  flushIds?: readonly string[];
  children: ReactNode;
}>) {
  const params = useParams();
  const pathname = usePathname();
  const basePath = `/weldflow/project/${params.projectId as string}/${section}`;
  const activeId = activeSubNavId(pathname, basePath, items);
  const fullBleed = activeId === fullBleedId;
  const flush = flushIds?.includes(activeId) ?? false;

  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  const context = useMemo<SubNavContextValue>(
    () => ({ label, basePath, items, activeId, slot, claim }),
    [label, basePath, items, activeId, slot, claim],
  );

  let content = 'min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-8 md:px-4';
  if (fullBleed) content = 'flex min-h-0 flex-1 flex-col';
  else if (flush) content = 'flex min-h-0 flex-1 flex-col overflow-y-auto';

  return (
    <SubNavContext.Provider value={context}>
      <div className="flex h-full min-h-0 flex-col">
        <div ref={setSlot} className="contents" />
        {claims === 0 ? <ListToolbar leftActionButtons={<SubNavTabs />} className="shrink-0 pt-2 pb-2" /> : null}
        {/* The bar keeps its left side for wider screens; on a phone the sub-tabs get a row of their own. */}
        <div className="shrink-0 overflow-x-auto border-b border-border px-3 py-2 md:hidden">
          <SubNavTabs />
        </div>
        <div className={content}>{children}</div>
      </div>
    </SubNavContext.Provider>
  );
}
