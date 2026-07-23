import * as React from 'react';
import {
  Bell,
  Briefcase,
  Calendar,
  LayoutGrid,
  LifeBuoy,
  Mail,
  Search,
  Users,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { cn } from '@weldsuite/ui/lib/utils';

export type AppModule = 'WeldCRM' | 'WeldFlow' | 'WeldDesk' | 'WeldMail' | 'WeldMeet';

const RAIL: { module: AppModule; icon: React.ComponentType<{ className?: string }> }[] = [
  { module: 'WeldCRM', icon: Users },
  { module: 'WeldFlow', icon: Briefcase },
  { module: 'WeldDesk', icon: LifeBuoy },
  { module: 'WeldMail', icon: Mail },
  { module: 'WeldMeet', icon: Calendar },
];

export interface AppFrameProps {
  /** Which module rail icon is highlighted. */
  module: AppModule;
  /** Breadcrumb segments, e.g. ['People', 'Mara Devlin']. */
  breadcrumb: string[];
  children: React.ReactNode;
}

/**
 * A lightweight, STATIC recreation of the platform shell — a module rail and a
 * top bar — purely so the flow screens read as "inside WeldSuite". It is not
 * the real `@weldsuite/ui` app-sidebar (which needs Clerk/router); it renders
 * with theming alone.
 */
export function AppFrame({ module, breadcrumb, children }: AppFrameProps) {
  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      {/* Module rail */}
      <nav
        aria-label="Modules"
        className="hidden w-14 flex-shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/30 py-3 sm:flex"
      >
        <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <LayoutGrid className="h-4 w-4" />
        </div>
        {RAIL.map(({ module: m, icon: Icon }) => {
          const activeRail = m === module;
          return (
            <div
              key={m}
              title={m}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                activeRail
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Icon className="h-[18px] w-[18px]" />
            </div>
          );
        })}
      </nav>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-12 flex-shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="font-semibold text-foreground">{module}</span>
            {breadcrumb.map((seg, i) => (
              <React.Fragment key={`${seg}-${i}`}>
                <span className="text-muted-foreground/50">/</span>
                <span
                  className={cn(
                    'truncate',
                    i === breadcrumb.length - 1
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {seg}
                </span>
              </React.Fragment>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground md:flex">
              <Search className="h-3.5 w-3.5" />
              <span>Search…</span>
            </div>
            <Bell className="h-4 w-4 text-muted-foreground" />
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-xs">YO</AvatarFallback>
            </Avatar>
          </div>
        </header>

        {/* Page body */}
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
