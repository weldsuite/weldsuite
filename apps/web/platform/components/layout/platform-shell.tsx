
import * as React from 'react';
import { AppSidebarClient } from '@/components/app-sidebar-client';
import { MobileNavWrapper } from './mobile-nav-wrapper';
import { NavigationProgressBar } from './navigation-progress-bar';
import { SidebarProvider } from '@weldsuite/ui/components/sidebar';
import { UnifiedModuleSidebar } from './unified-module-sidebar';
import { MainContentArea } from './main-content-area';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useUser, useOrganization, useOrganizationList } from '@clerk/clerk-react';
import { AppAccessGuard } from '@/components/app-access-guard';

interface PlatformShellProps {
  children: React.ReactNode;
}

export function PlatformShell({ children }: PlatformShellProps) {
  const { data: installedApps = [] } = useInstalledApps();
  const { user } = useUser();
  const { organization } = useOrganization();
  const { userMemberships } = useOrganizationList({ userMemberships: true });

  const userInfo = user
    ? {
        name: user.fullName || user.firstName || '',
        email: user.emailAddresses[0]?.emailAddress || '',
        avatar: user.imageUrl,
      }
    : undefined;

  const currentWorkspace = organization
    ? {
        id: organization.id,
        name: organization.name,
      }
    : null;

  const workspaces =
    userMemberships?.data?.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
    })) || [];

  return (
    <MobileNavWrapper installedApps={installedApps}>
      {/* Layered "chrome" shell: the whole viewport is a soft gray backdrop;
          the far-left rail is transparent (chrome shows through), the module
          sidebar becomes a floating rounded panel, and the page content sits
          on top as a rounded card. The two color-mix tones derive from the
          theme tokens so this tracks light/dark automatically. */}
      <div
        className="relative h-screen overflow-hidden bg-[var(--shell-chrome)]"
        style={
          {
            '--shell-panel':
              'color-mix(in oklch, var(--background) 94%, var(--foreground))',
            '--shell-chrome':
              'color-mix(in oklch, var(--background) 88%, var(--foreground))',
          } as React.CSSProperties
        }
      >
        {/* Global AppSidebar on the far left - fixed, hidden on mobile */}
        <div className="hidden md:block fixed left-0 top-0 h-screen z-50">
          <AppSidebarClient installedApps={installedApps} />
        </div>

        {/* Content area - no margin on mobile, ml-16 on desktop */}
        {/* pt-14 on mobile for header, pt-0 on desktop */}
        <MainContentArea>
          <SidebarProvider className="min-h-0 h-full">
            <div className="flex h-full w-full overflow-hidden">
              <UnifiedModuleSidebar
                user={userInfo}
                currentWorkspace={currentWorkspace}
                workspaces={workspaces}
              />
              {/* Slim top-edge progress bar for slow navigations. The page
                  itself stays mounted while the router works — swapping the
                  content for a spinner here (the old NavigationLoadingWrapper)
                  produced a spinner→skeleton→content triple flash. */}
              <NavigationProgressBar />
              {/* Content card — the gray "chrome" surface, inset from the
                  viewport. The module page inside renders its full-width header
                  followed by <ModuleContent>, which lays the content, object
                  panel(s) and drawers out as a flex row (rounded white cards
                  separated by the row's gap). On mobile it stays full-bleed. */}
              <div className="relative flex flex-1 min-w-0 h-full md:py-2 md:pr-2">
                {/* Round only the right side: the card sits flush against the
                    module sidebar on its left, so rounding the left corners
                    would carve a weird notch at the sidebar seam (the header's
                    top-left). The right side faces the chrome gap, so it rounds. */}
                <div className="relative z-10 flex flex-1 min-w-0 flex-col overflow-hidden bg-[var(--shell-panel)] md:rounded-r-xl">
                  <AppAccessGuard>
                    {children}
                  </AppAccessGuard>
                </div>
              </div>
            </div>
          </SidebarProvider>
        </MainContentArea>
      </div>
    </MobileNavWrapper>
  );
}
