
import { DashboardSidebarClient } from './components/dashboard-sidebar-client';
import { DashboardLayoutClient } from './components/dashboard-layout-client';
import {
  SidebarProvider,
} from '@weldsuite/ui/components/sidebar';
import { useUser, useOrganization, useOrganizationList } from '@clerk/clerk-react';
import { useInstalledApps } from '@/hooks/use-installed-apps';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useUser();
  const { organization } = useOrganization();
  const { userMemberships } = useOrganizationList({ userMemberships: true });
  const { data: installedApps = [] } = useInstalledApps();

  const userData = user
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
    <SidebarProvider>
      <div className="flex h-screen w-full bg-background">
        <DashboardSidebarClient
          user={userData}
          currentWorkspace={currentWorkspace}
          workspaces={workspaces}
          installedApps={installedApps}
        />
        <DashboardLayoutClient>
          {children}
        </DashboardLayoutClient>
      </div>
    </SidebarProvider>
  );
}
