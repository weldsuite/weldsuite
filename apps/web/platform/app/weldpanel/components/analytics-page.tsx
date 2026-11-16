/**
 * Shell of an analytics page: waits for the current project, handles "no
 * project" and "projects failed to load", then renders the page title row and
 * `children(project)` in the library's `DashboardPage`.
 */

import type { ReactNode } from 'react';
import { ChartSpline } from 'lucide-react';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { useCurrentProject } from '../lib/use-current-project';

interface AnalyticsPageProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: (project: PanelProjectDto) => ReactNode;
  className?: string;
}

export function AnalyticsPage({ title, description, actions, children, className }: Readonly<AnalyticsPageProps>) {
  const { t } = useI18n();
  const { project, isLoading, isError, refetch } = useCurrentProject();

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  if (isError) {
    return (
      <DashboardPage title={title} description={description}>
        <ErrorState message={t.weldpanel.analytics.projectBar.loadFailed} onRetry={refetch} retryLabel={t.weldpanel.retry} />
      </DashboardPage>
    );
  }

  if (!project) {
    const tn = t.weldpanel.analytics.needProject;
    return (
      <DashboardPage title={title} description={description}>
        <EmptyState
          icon={ChartSpline}
          title={tn.title}
          description={tn.description}
          action={
            <Button asChild size="sm">
              <Link href="/weldpanel/projects">{tn.action}</Link>
            </Button>
          }
        />
      </DashboardPage>
    );
  }

  return (
    <DashboardPage title={title} description={description} actions={actions} className={className}>
      {children(project)}
    </DashboardPage>
  );
}
