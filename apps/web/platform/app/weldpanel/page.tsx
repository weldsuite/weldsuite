import { useMemo, useState } from 'react';
import { ChartSpline, Code, Filter, Info, Plus, PlayCircle } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useWeldPanelProjects } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { CreateProjectDialog } from './components/create-project-dialog';
import { InstallStatus } from './components/install-status';
import { ProjectKindBadge, ProjectStatusBadge } from './components/project-badges';
import { pickProject, readLastProjectId, writeLastProjectId } from './lib/last-project';

/**
 * WeldPanel home. Phase 1 of docs/plans/weldpanel.md (collect): without a
 * project it offers to create one; with projects it shows the installation
 * status of the one picked (the last one used in this workspace). The Overview
 * dashboard with traffic numbers replaces the status card in phase 2.
 */
export default function WeldPanelHome() {
  const { t } = useI18n();
  const th = t.weldpanel.home;
  const canCreate = useCan('panel_projects:create');
  const workspaceId = useWorkspaceId();
  const { data: projects, isLoading, isError, refetch } = useWeldPanelProjects();
  const [creating, setCreating] = useState(false);
  const [chosenId, setChosenId] = useState<string | null>(null);

  const lastId = useMemo(() => readLastProjectId(workspaceId), [workspaceId]);
  const selected = pickProject(projects ?? [], chosenId, lastId);

  function choose(id: string) {
    setChosenId(id);
    writeLastProjectId(workspaceId, id);
  }

  const steps = [
    { icon: Code, ...th.steps.install },
    { icon: Filter, ...th.steps.analyse },
    { icon: PlayCircle, ...th.steps.watch },
  ];

  const newProjectButton = canCreate && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus />
      {th.newProject}
    </Button>
  );

  const header = (action: React.ReactNode) => (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{th.title}</h1>
        <p className="text-sm text-muted-foreground">{th.description}</p>
      </div>
      {action}
    </div>
  );

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  if (isError || !projects) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 p-10 text-center">
        <p className="text-sm text-muted-foreground">{th.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t.weldpanel.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      {header(projects.length > 0 ? newProjectButton : null)}

      {selected ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="weldpanel-project-picker">{th.projectLabel}</Label>
              <Select value={selected.id} onValueChange={choose}>
                <SelectTrigger id="weldpanel-project-picker" className="w-64 max-w-full">
                  <SelectValue placeholder={th.projectPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pb-1.5">
              <ProjectKindBadge kind={selected.kind} />
              <ProjectStatusBadge status={selected.status} />
            </div>
            <Button asChild variant="ghost" size="sm" className="ml-auto">
              <Link href="/weldpanel/projects">{th.allProjects}</Link>
            </Button>
          </div>

          {/* Keyed by project: switching starts a fresh status check instead of showing the last project's. */}
          <InstallStatus key={selected.id} projectId={selected.id} paused={selected.status === 'paused'} showLink />

          <Alert>
            <Info />
            <AlertTitle>{th.reportsTitle}</AlertTitle>
            <AlertDescription>{th.reportsDescription}</AlertDescription>
          </Alert>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center">
            <ChartSpline className="size-8 text-muted-foreground" />
            <p className="font-medium">{th.emptyTitle}</p>
            <p className="max-w-md text-sm text-muted-foreground">{th.emptyDescription}</p>
            {canCreate ? (
              <div className="mt-2">{newProjectButton}</div>
            ) : (
              <p className="max-w-md text-sm text-muted-foreground">{th.emptyNoCreate}</p>
            )}
          </div>

          <ol className="grid gap-4 sm:grid-cols-3">
            {steps.map(({ icon: Icon, title, description }) => (
              <li key={title} className="flex gap-3 rounded-lg border bg-card p-4">
                <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
