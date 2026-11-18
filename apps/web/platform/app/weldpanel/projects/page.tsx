/**
 * WeldPanel projects: every website and app the workspace tracks. A row opens
 * the project (install, settings); "New project" opens the create dialog, which
 * lands on the new project's Install tab.
 */

import { useState } from 'react';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { Globe } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWeldPanelProjects } from '@/hooks/queries/use-weldpanel-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { CreateProjectDialog } from '../components/create-project-dialog';
import { ProjectKindBadge, ProjectStatusBadge } from '../components/project-badges';

/** How many domains a row names before it says "+N more". */
const DOMAINS_SHOWN = 2;

export default function WeldPanelProjectsPage() {
  const { t, format, language } = useI18n();
  const tp = t.weldpanel.projects;
  const router = useRouter();
  const canCreate = useCan('panel_projects:create');
  const { data: projects, isLoading, isError, refetch } = useWeldPanelProjects();
  const [creating, setCreating] = useState(false);
  useCreateIntent(() => setCreating(true), { ready: canCreate });

  useBreadcrumbs([{ label: t.weldpanel.breadcrumb.home, href: '/weldpanel' }, { label: t.weldpanel.breadcrumb.projects }]);

  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  const columns: ColumnDef<PanelProjectDto>[] = [
    {
      id: 'name',
      header: tp.table.name,
      width: 'flex-1',
      render: (project) => <span className="block truncate font-medium">{project.name}</span>,
    },
    {
      id: 'kind',
      header: tp.table.kind,
      width: 'hidden sm:block sm:w-[110px]',
      render: (project) => <ProjectKindBadge kind={project.kind} />,
    },
    {
      id: 'status',
      header: tp.table.status,
      width: 'w-[110px]',
      render: (project) => <ProjectStatusBadge status={project.status} />,
    },
    {
      id: 'domains',
      header: tp.table.domains,
      width: 'hidden md:block md:w-[240px]',
      render: (project) => {
        if (project.allowedDomains.length === 0) return <span className="text-sm text-muted-foreground">{tp.anySite}</span>;
        const extra = project.allowedDomains.length - DOMAINS_SHOWN;
        return (
          <span className="block truncate text-sm">
            {project.allowedDomains.slice(0, DOMAINS_SHOWN).join(', ')}
            {extra > 0 && <span className="text-muted-foreground"> {format(tp.moreDomains, { count: extra })}</span>}
          </span>
        );
      },
    },
    {
      id: 'created',
      header: tp.table.created,
      width: 'hidden lg:block lg:w-[120px]',
      render: (project) => (
        <time dateTime={project.createdAt} className="text-sm tabular-nums text-muted-foreground">
          {dateFormat.format(new Date(project.createdAt))}
        </time>
      ),
    },
  ];

  const openCreate = () => setCreating(true);

  // The shared list words its own loading and error states in English only.
  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError || !projects) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <p className="text-sm text-muted-foreground">{tp.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t.weldpanel.retry}
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Where projects are all there is (no analytics store), say so rather than leave it to be found out. */}
      {!isFeatureAvailable('panel-analytics') && (
        <InfoBanner variant="info" title={tp.editionNoticeTitle} className="m-4 mb-0">
          {tp.editionNotice}
        </InfoBanner>
      )}
      <PanelEntityList<PanelProjectDto>
        items={projects}
        isLoading={false}
        columns={columns}
        // Nothing to filter projects on: the popover would be empty.
        hideFilter
        onRowClick={(project) => router.push(`/weldpanel/projects/${project.id}`)}
        createButton={canCreate ? { label: tp.newProject, onClick: openCreate } : undefined}
        emptyState={{
          icon: <Globe className="size-8 text-muted-foreground" />,
          title: tp.emptyTitle,
          description: tp.emptyDescription,
          action: canCreate ? { label: tp.newProject, onClick: openCreate } : undefined,
        }}
      />
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
