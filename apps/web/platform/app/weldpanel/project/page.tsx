/**
 * One WeldPanel project: install (snippets and status), general settings,
 * privacy & collection, and the danger zone. Every tab shows to anyone who can
 * read the project; what can be changed depends on `panel_projects:update`,
 * `:manage` and `:delete`, and the danger zone is hidden from those who have
 * neither of the last two.
 */

import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { PauseCircle } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { useCan } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useWeldPanelProject } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { ProjectKindBadge, ProjectStatusBadge } from '../components/project-badges';
import { writeLastProjectId } from '../lib/last-project';
import { DangerTab } from './danger-tab';
import { GeneralTab } from './general-tab';
import { InstallTab } from './install-tab';
import { PrivacyTab } from './privacy-tab';

type TabId = 'install' | 'general' | 'privacy' | 'danger';

export default function WeldPanelProjectPage() {
  const { projectId = '' } = useParams({ strict: false });
  return <ProjectView key={projectId} projectId={projectId} />;
}

function ProjectView({ projectId }: Readonly<{ projectId: string }>) {
  const { t, format, language } = useI18n();
  const tp = t.weldpanel.project;
  const workspaceId = useWorkspaceId();
  const { data: project, isLoading, error, refetch } = useWeldPanelProject(projectId);
  const canUpdate = useCan('panel_projects:update');
  const canManage = useCan('panel_projects:manage');
  const canDelete = useCan('panel_projects:delete');
  const [tab, setTab] = useState<TabId>('install');

  useBreadcrumbs(
    [
      { label: t.weldpanel.breadcrumb.home, href: '/weldpanel' },
      { label: t.weldpanel.breadcrumb.projects, href: '/weldpanel/projects' },
      { label: project?.name ?? '…' },
    ],
    { enabled: !!project },
  );

  // The Overview opens on the project last looked at.
  useEffect(() => {
    if (project) writeLastProjectId(workspaceId, project.id);
  }, [workspaceId, project]);

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  if (error || !project) {
    const notFound = isApiError(error) && error.status === 404;
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <p className="text-sm text-muted-foreground">{notFound ? tp.notFound : tp.loadFailed}</p>
        {notFound ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/weldpanel/projects">{tp.back}</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t.weldpanel.retry}
          </Button>
        )}
      </div>
    );
  }

  const showDanger = canManage || canDelete;
  // A tab can disappear (permissions load after the first render); fall back rather than show nothing.
  const activeTab: TabId = tab === 'danger' && !showDanger ? 'install' : tab;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 truncate text-xl font-semibold">{project.name}</h1>
          <ProjectKindBadge kind={project.kind} />
          <ProjectStatusBadge status={project.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {format(tp.created, { date: new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(project.createdAt)) })}
        </p>
      </div>

      {project.status === 'paused' && (
        <Alert>
          <PauseCircle />
          <AlertTitle>{tp.pausedTitle}</AlertTitle>
          <AlertDescription>{tp.pausedDescription}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabId)} className="gap-4">
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="install">{tp.tabs.install}</TabsTrigger>
          <TabsTrigger value="general">{tp.tabs.general}</TabsTrigger>
          <TabsTrigger value="privacy">{tp.tabs.privacy}</TabsTrigger>
          {showDanger && <TabsTrigger value="danger">{tp.tabs.danger}</TabsTrigger>}
        </TabsList>
        <TabsContent value="install">
          <InstallTab project={project} />
        </TabsContent>
        <TabsContent value="general">
          <GeneralTab project={project} canUpdate={canUpdate} />
        </TabsContent>
        <TabsContent value="privacy">
          <PrivacyTab project={project} canManage={canManage} />
        </TabsContent>
        {showDanger && (
          <TabsContent value="danger">
            <DangerTab project={project} canManage={canManage} canDelete={canDelete} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
