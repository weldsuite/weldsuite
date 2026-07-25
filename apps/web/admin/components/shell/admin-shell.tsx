'use client';

import * as React from 'react';
import { SidebarProvider } from '@weldsuite/ui/components/sidebar';
import { cn } from '@/lib/utils';
import type { AdminRole } from '@/lib/roles';
import { AdminHeader } from './admin-header';
import { AdminRail } from './admin-rail';
import { AdminSidebar } from './admin-sidebar';

interface AdminShellProps {
  name: string | null;
  email: string;
  role: AdminRole;
  avatar?: string;
  children: React.ReactNode;
}

/**
 * Layered "chrome" shell, identical in construction to the platform's
 * `PlatformShell`: the viewport is a soft gray backdrop, the far-left rail is
 * transparent so the chrome shows through, the module sidebar is a floating
 * rounded panel, and the page content sits on top as a rounded card. Both
 * color-mix tones derive from the theme tokens, so this tracks light/dark
 * automatically.
 */
export function AdminShell({ name, email, role, avatar, children }: AdminShellProps) {
  return (
    <div
      className="relative h-screen overflow-hidden bg-[var(--shell-chrome)]"
      style={
        {
          '--shell-panel': 'color-mix(in oklch, var(--background) 94%, var(--foreground))',
          '--shell-chrome': 'color-mix(in oklch, var(--background) 88%, var(--foreground))',
        } as React.CSSProperties
      }
    >
      {/* Far-left rail — fixed, above the sidebar panel. */}
      <div className="fixed left-0 top-0 z-50 hidden h-screen md:block">
        <AdminRail />
      </div>

      <div className="ml-0 h-screen overflow-hidden md:ml-16">
        <SidebarProvider className="h-full min-h-0">
          <div className="flex h-full w-full overflow-hidden">
            <AdminSidebar name={name} email={email} role={role} avatar={avatar} />

            {/* Content card — rounded only on the right: its left edge sits
                flush against the sidebar panel, so rounding there would carve
                a notch at the seam. */}
            <div className="relative flex h-full min-w-0 flex-1 md:py-2 md:pr-2">
              <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--shell-panel)] md:rounded-r-xl">
                <AdminHeader />
                {children}
              </div>
            </div>
          </div>
        </SidebarProvider>
      </div>
    </div>
  );
}

/**
 * The content row for a page — the admin twin of the platform's
 * `ModuleContent`. Sits below the header and renders the page on a white
 * rounded card inset from the panel by the shell's uniform gap.
 */
export function PageContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 p-2">
      <div
        data-module-content
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-background',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Scrolling page body with the platform's page padding + max width. Most admin
 * pages want `<PageContent><PageBody>…</PageBody></PageContent>`.
 */
export function PageBody({
  children,
  className,
  width = 'wide',
}: {
  children: React.ReactNode;
  className?: string;
  width?: 'wide' | 'narrow' | 'full';
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        className={cn(
          'p-6',
          width === 'wide' && 'mx-auto max-w-6xl',
          width === 'narrow' && 'mx-auto max-w-3xl',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Page title + description block, matching the platform's settings pages. */
export function PageHeading({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
