/**
 * The frame every page of one WeldPass project shares: the breadcrumb trail,
 * the toolbar row with the back button and the Secrets / Sync / Audit log tabs. The three sections are separate
 * routes, so a tab change is a navigation and each one can be linked to. A
 * section's own search and buttons join the back button in the toolbar row.
 */

import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { KeyRound, RefreshCw, ScrollText } from 'lucide-react';
import type { PageTab } from '@weldsuite/ui/components/page-tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldPassProject } from '@/hooks/queries/use-weldpass-queries';
import { TabsPage, usePassBreadcrumbs, type TabsPageToolbar } from '../../components/page-kit';

export type ProjectSection = 'secrets' | 'sync' | 'audit';

const ROUTES = {
  secrets: '/weldpass/$projectId',
  sync: '/weldpass/$projectId/sync',
  audit: '/weldpass/$projectId/audit',
} as const;

export function ProjectPage({
  projectId,
  section,
  toolbar,
  children,
}: Readonly<{
  projectId: string;
  section: ProjectSection;
  toolbar?: TabsPageToolbar;
  children: ReactNode;
}>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const { data: project } = useWeldPassProject(projectId);

  const tabs: PageTab[] = [
    { id: 'secrets', label: t('weldpass.secretsTab'), icon: KeyRound },
    { id: 'sync', label: t('weldpass.sync'), icon: RefreshCw },
    { id: 'audit', label: t('weldpass.auditLog'), icon: ScrollText },
  ];

  usePassBreadcrumbs(
    { label: t('weldpass.projects'), href: '/weldpass' },
    {
      label: project?.name ?? '…',
      href: section === 'secrets' ? undefined : `/weldpass/${projectId}`,
    },
    section !== 'secrets' && { label: tabs.find((tab) => tab.id === section)?.label ?? '' },
  );

  return (
    <TabsPage
      onBack={() => void navigate({ to: '/weldpass' })}
      toolbar={toolbar}
      tabs={tabs}
      activeTab={section}
      onTabChange={(tabId) =>
        void navigate({ to: ROUTES[tabId as ProjectSection], params: { projectId } })
      }
    >
      {children}
    </TabsPage>
  );
}
