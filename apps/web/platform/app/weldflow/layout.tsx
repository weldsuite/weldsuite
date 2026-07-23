
import { useAppAccess } from '@/hooks/use-app-access';
import { ProjectsLayoutClient } from './components/projects-layout-client';
import { WorkspaceProvider } from '@/contexts/workspace-context';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ProjectsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldflow');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.projects.layout.appNotInstalled}</div>;

  return (
    <WorkspaceProvider>
      <ProjectsLayoutClient>
        {children}
      </ProjectsLayoutClient>
    </WorkspaceProvider>
  );
}
