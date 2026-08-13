'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Shield } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import { cn } from '@/lib/utils';
import { getNavAreas, getActiveArea } from './nav-config';

/**
 * The far-left rail — the admin console's answer to the platform's app
 * switcher. Transparent on purpose: the shell chrome shows through, exactly
 * like `AppSidebarClient` in apps/web/platform.
 */
export function AdminRail() {
  const pathname = usePathname() ?? '/';
  const activeArea = getActiveArea(pathname);

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-full w-16 flex-col items-center gap-1 py-3">
        <Link
          href="/"
          aria-label="WeldSuite Admin"
          className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg text-primary"
        >
          <Shield className="h-5 w-5" />
        </Link>

        {getNavAreas().map((area) => {
          const Icon = area.icon;
          const isActive = area.key === activeArea.key;
          return (
            <Tooltip key={area.key}>
              <TooltipTrigger asChild>
                <Link
                  href={area.href}
                  data-testid={`admin-nav-${area.key}`}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'group relative flex h-12 w-12 items-center justify-center rounded-lg transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    isActive && 'bg-gray-200/60 text-foreground dark:bg-accent/60',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-5 w-5 transition-opacity',
                      !isActive && 'opacity-60 group-hover:opacity-100',
                    )}
                  />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{area.name}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
