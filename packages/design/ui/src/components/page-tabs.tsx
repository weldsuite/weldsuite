import React from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';

export interface PageTab {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  count?: number;
  href?: string;
}

export interface PageTabsProps {
  tabs: PageTab[];
  activeTab: string;
  onTabChange?: (tabId: string) => void;
  /**
   * Component used to render tabs that have an `href`. Defaults to a plain
   * anchor (`'a'`). Pass a router-aware link (e.g. TanStack Router's `Link`)
   * to get client-side navigation. The component receives `href`, `className`
   * and `children`.
   */
  linkComponent?: React.ElementType;
  renderTabWrapper?: (
    tab: PageTab,
    index: number,
    tabElement: React.ReactNode,
  ) => React.ReactNode;
  className?: string;
  innerClassName?: string;
  children?: React.ReactNode;
  /**
   * How to handle tabs that don't fit the available width.
   * - `scroll` (default): horizontal scroll, original behaviour.
   * - `dropdown`: Attio-style — tabs that don't fit collapse into a
   *   "+N more" dropdown at the end of the row. The active tab's selected
   *   state is reflected on the "+N more" trigger when it overflows.
   *   Only supported when no custom `renderTabWrapper` is provided
   *   (wrappers imply bespoke per-tab markup); otherwise falls back to
   *   `scroll`.
   */
  overflow?: 'scroll' | 'dropdown';
}

const GAP_PX = 8; // matches `gap-2`

function TabInner({
  tab,
  isActive,
  isFirst,
}: {
  tab: PageTab;
  isActive: boolean;
  isFirst: boolean;
}) {
  const Icon = tab.icon;
  return (
    <>
      <span
        className={cn(
          'flex items-center gap-2 text-sm font-medium transition-colors px-2 py-1',
          isFirst && '-ml-2',
          isActive
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground group-data-[state=open]/tab:text-foreground',
        )}
      >
        {Icon && <Icon className="h-4 w-4" />}
        {tab.label}
        {tab.count !== undefined && tab.count > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground bg-muted border border-border min-w-[15px] h-[15px] flex items-center justify-center rounded-[5px] px-1">
            <span className="translate-y-[1px]">{tab.count}</span>
          </span>
        )}
      </span>
      {!isActive && (
        <span
          className={cn(
            'absolute -bottom-px h-[2px] bg-muted-foreground/40 opacity-0 group-hover/tab:opacity-100 group-data-[state=open]/tab:opacity-100 transition-opacity z-20',
            isFirst ? 'left-0 right-2' : 'left-2 right-2',
          )}
        />
      )}
      {isActive && (
        <span
          className={cn(
            'absolute -bottom-px h-[2px] bg-foreground z-20',
            isFirst ? 'left-0 right-2' : 'left-2 right-2',
          )}
        />
      )}
    </>
  );
}

function TabButton({
  tab,
  isActive,
  isFirst,
  onTabChange,
  linkComponent,
}: {
  tab: PageTab;
  isActive: boolean;
  isFirst: boolean;
  onTabChange?: (tabId: string) => void;
  linkComponent?: React.ElementType;
}) {
  if (tab.href) {
    const LinkComponent = linkComponent ?? 'a';
    return (
      <LinkComponent
        href={tab.href}
        className="group/tab relative pb-2 flex items-center flex-shrink-0"
      >
        <TabInner tab={tab} isActive={isActive} isFirst={isFirst} />
      </LinkComponent>
    );
  }
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => onTabChange?.(tab.id)}
      className="group/tab relative pb-2 flex items-center flex-shrink-0"
    >
      <TabInner tab={tab} isActive={isActive} isFirst={isFirst} />
    </button>
  );
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/**
 * Attio-style overflow: render as many tabs as fit, collapse the rest into a
 * "+N more" dropdown. Widths are measured from a hidden mirror layer so the
 * computation stays accurate as labels / counts / container width change.
 */
function OverflowTabs({
  tabs,
  activeTab,
  onTabChange,
  linkComponent,
  innerClassName,
  children,
}: Pick<
  PageTabsProps,
  'tabs' | 'activeTab' | 'onTabChange' | 'linkComponent' | 'innerClassName' | 'children'
>) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const moreRef = React.useRef<HTMLDivElement>(null);
  const tabRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const [available, setAvailable] = React.useState(0);
  const [widths, setWidths] = React.useState<number[]>([]);
  const [moreWidth, setMoreWidth] = React.useState(0);

  // Track the row's content width (excludes padding via contentRect).
  React.useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setAvailable(w);
    });
    ro.observe(el);
    setAvailable(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Measure each tab + the "more" button from the hidden mirror.
  React.useLayoutEffect(() => {
    tabRefs.current.length = tabs.length;
    const next = tabs.map((_, i) => tabRefs.current[i]?.offsetWidth ?? 0);
    setWidths(next);
    setMoreWidth(moreRef.current?.offsetWidth ?? 0);
  }, [tabs]);

  const { visibleIndices, overflowIndices } = React.useMemo(() => {
    const n = tabs.length;
    const measured = widths.length === n && available > 0 && widths.every((w) => w > 0);
    if (!measured) {
      return { visibleIndices: tabs.map((_, i) => i), overflowIndices: [] as number[] };
    }

    const total = widths.reduce((sum, w, i) => sum + w + (i > 0 ? GAP_PX : 0), 0);
    if (total <= available) {
      return { visibleIndices: tabs.map((_, i) => i), overflowIndices: [] as number[] };
    }

    const reserve = moreWidth + GAP_PX;
    const budget = available - reserve;
    let used = 0;
    let fit = 0;
    for (let i = 0; i < n; i++) {
      const need = widths[i] + (fit > 0 ? GAP_PX : 0);
      if (used + need <= budget) {
        used += need;
        fit++;
      } else break;
    }

    // Keep the natural prefix visible; the rest collapse into "+N more". When
    // the active tab is one of the overflowed tabs we don't pull it forward —
    // instead the "+N more" trigger itself renders selected (see below).
    return {
      visibleIndices: range(0, fit),
      overflowIndices: range(fit, n),
    };
  }, [tabs, widths, available, moreWidth]);

  const hasOverflow = overflowIndices.length > 0;
  const overflowActive = overflowIndices.some((i) => tabs[i]?.id === activeTab);

  return (
    <div className="relative w-full min-w-0">
      <div ref={rowRef} className={cn('flex items-center w-full min-w-0', innerClassName)}>
        <div role="tablist" className="flex items-center gap-2 min-w-0">
          {visibleIndices.map((tabIndex, pos) => {
            const tab = tabs[tabIndex];
            return (
              <TabButton
                key={tab.id}
                tab={tab}
                isActive={activeTab === tab.id}
                isFirst={pos === 0}
                onTabChange={onTabChange}
                linkComponent={linkComponent}
              />
            );
          })}

          {hasOverflow && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="group/tab relative pb-2 flex items-center flex-shrink-0"
                  aria-label="More tabs"
                >
                  <span
                    className={cn(
                      'flex items-center gap-1 text-sm font-medium transition-colors px-2 py-1 whitespace-nowrap',
                      overflowActive
                        ? 'text-foreground'
                        : 'text-muted-foreground hover:text-foreground group-data-[state=open]/tab:text-foreground',
                    )}
                  >
                    +{overflowIndices.length} more
                  </span>
                  {overflowActive ? (
                    <span className="absolute -bottom-px h-[2px] bg-foreground left-2 right-2 z-20" />
                  ) : (
                    <span className="absolute -bottom-px h-[2px] bg-muted-foreground/40 opacity-0 group-hover/tab:opacity-100 group-data-[state=open]/tab:opacity-100 transition-opacity left-2 right-2 z-20" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {overflowIndices.map((tabIndex) => {
                  const tab = tabs[tabIndex];
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;

                  const itemContent = (
                    <>
                      {Icon && <Icon className="h-4 w-4 mr-2 text-muted-foreground" />}
                      <span className="flex-1 truncate">{tab.label}</span>
                      {tab.count !== undefined && tab.count > 0 && (
                        <span className="ml-2 text-[10px] font-mono text-muted-foreground bg-muted border border-border min-w-[15px] h-[15px] flex items-center justify-center rounded-[5px] px-1">
                          {tab.count}
                        </span>
                      )}
                    </>
                  );

                  // Mirror the visible-tab behaviour: href tabs navigate via the
                  // provided link component, otherwise fall back to onTabChange.
                  if (tab.href) {
                    const LinkComponent = linkComponent ?? 'a';
                    return (
                      <DropdownMenuItem
                        key={tab.id}
                        asChild
                        className={cn(isActive && 'bg-muted')}
                      >
                        <LinkComponent href={tab.href} className="flex w-full items-center">
                          {itemContent}
                        </LinkComponent>
                      </DropdownMenuItem>
                    );
                  }

                  return (
                    <DropdownMenuItem
                      key={tab.id}
                      onClick={() => onTabChange?.(tab.id)}
                      className={cn(isActive && 'bg-muted')}
                    >
                      {itemContent}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {children}
      </div>

      {/* Hidden mirror used purely for width measurement. */}
      <div
        ref={measureRef}
        aria-hidden
        className="absolute left-0 top-0 flex items-center gap-2 opacity-0 pointer-events-none -z-10"
      >
        {tabs.map((tab, i) => (
          <div
            key={tab.id}
            ref={(node) => {
              tabRefs.current[i] = node;
            }}
            className="group/tab relative pb-2 flex items-center flex-shrink-0"
          >
            <TabInner tab={tab} isActive={false} isFirst={i === 0} />
          </div>
        ))}
        <div ref={moreRef} className="group/tab relative pb-2 flex items-center flex-shrink-0">
          <span className="flex items-center gap-1 text-sm font-medium px-2 py-1 whitespace-nowrap">
            +88 more
          </span>
        </div>
      </div>
    </div>
  );
}

export function PageTabs({
  tabs,
  activeTab,
  onTabChange,
  linkComponent,
  renderTabWrapper,
  className,
  innerClassName,
  children,
  overflow = 'scroll',
}: PageTabsProps) {
  // Dropdown overflow mode (Attio-style "+N more"). Only supported when no
  // custom tab wrapper is provided — wrappers imply bespoke per-tab markup.
  if (overflow === 'dropdown' && !renderTabWrapper) {
    return (
      <div className={cn('relative', className)}>
        <div className="absolute left-0 right-0 bottom-0 h-px bg-border pointer-events-none" />
        <OverflowTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={onTabChange}
          linkComponent={linkComponent}
          innerClassName={innerClassName}
        >
          {children}
        </OverflowTabs>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      {/* Bottom border line rendered as an absolute sibling so the active/hover
          underlines can overlap it without being clipped by the scroll container. */}
      <div className="absolute left-0 right-0 bottom-0 h-px bg-border pointer-events-none" />
      <div
        className={cn(
          'flex items-center overflow-x-auto pb-px [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
          innerClassName,
        )}
      >
        <div role="tablist" className="flex items-center gap-2">
          {tabs.map((tab, index) => {
            const isActive = activeTab === tab.id;
            const isFirst = index === 0;

            const tabElement = (
              <TabButton
                key={tab.id}
                tab={tab}
                isActive={isActive}
                isFirst={isFirst}
                onTabChange={onTabChange}
                linkComponent={linkComponent}
              />
            );

            if (renderTabWrapper) {
              return (
                <React.Fragment key={tab.id}>
                  {renderTabWrapper(tab, index, tabElement)}
                </React.Fragment>
              );
            }

            return tabElement;
          })}
        </div>
        {children}
      </div>
    </div>
  );
}
