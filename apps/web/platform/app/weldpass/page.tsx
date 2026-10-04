/**
 * WeldPass projects — the developer-secrets list, and the module's landing page.
 * The list is the whole page: its top bar carries search and "New project",
 * and the breadcrumb is the title.
 *
 * Members who can use the password manager but cannot read secrets (the
 * default for regular members) are sent to the passwords page instead of an
 * error state.
 */

import { useState } from 'react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { WeldPassProject } from '@weldsuite/app-api-client/domains/weldpass';
import {
  useCreateWeldPassProject,
  useWeldPassProjects,
} from '@/hooks/queries/use-weldpass-queries';
import { PageLoader } from '@/components/page-loader';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { emptyIcon, usePassBreadcrumbs } from './components/page-kit';
import { ErrorBanner, TimeAgo, errorMessage } from './components/shared';

export default function WeldPassLandingPage() {
  const { can, isLoading } = usePermissions();

  // The project query needs secrets:read, so it must not mount for a member
  // who only has the password manager.
  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!can('secrets:read') && can('passwords:use')) {
    return <Navigate to="/weldpass/passwords" replace />;
  }
  return <WeldPassProjectsPage />;
}

function WeldPassProjectsPage() {
  const t = useTranslations();
  usePassBreadcrumbs({ label: t('weldpass.projects') });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { data: projects, isLoading, error } = useWeldPassProjects();
  const [creating, setCreating] = useState(false);

  const canCreate = can('secrets:create') || can('secrets:manage');
  const createButton = canCreate
    ? { label: t('weldpass.projectList.newProject'), onClick: () => setCreating(true) }
    : undefined;

  const columns: ColumnDef<WeldPassProject>[] = [
    {
      id: 'name',
      header: t('weldpass.projectList.table.name'),
      width: 'flex-1',
      render: (project) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{project.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {project.description || project.slug}
          </span>
        </span>
      ),
    },
    {
      id: 'environments',
      header: t('weldpass.projectList.table.environments'),
      width: 'w-[360px]',
      render: (project) => (
        <div className="flex flex-wrap gap-1">
          {project.environments.map((environment) => (
            <Link
              key={environment.id}
              to="/weldpass/$projectId"
              params={{ projectId: project.id }}
              search={{ env: environment.id }}
              // The badge opens its own environment; the row opens the first.
              onClick={(event) => event.stopPropagation()}
            >
              <Badge variant={environment.isProduction ? 'outline' : 'secondary'}>
                {environment.name} · {environment.secretCount ?? 0}
              </Badge>
            </Link>
          ))}
        </div>
      ),
    },
    {
      id: 'updated',
      header: t('weldpass.projectList.table.updated'),
      width: 'w-[140px]',
      render: (project) => (
        <span className="text-sm">
          <TimeAgo value={project.updatedAt} />
        </span>
      ),
    },
  ];

  return (
    <>
      <PanelEntityList<WeldPassProject>
        items={projects ?? []}
        isLoading={isLoading}
        error={error}
        columns={columns}
        onRowClick={(project) =>
          void navigate({ to: '/weldpass/$projectId', params: { projectId: project.id } })
        }
        searchFields={['name', 'slug', 'description']}
        searchPlaceholder={t('weldpass.projectList.searchPlaceholder')}
        createButton={createButton}
        emptyState={{
          icon: emptyIcon(KeyRound),
          title: t('weldpass.projectList.emptyTitle'),
          description: t('weldpass.projectList.emptyDescription'),
          action: canCreate
            ? { label: t('weldpass.projectList.emptyAction'), onClick: () => setCreating(true) }
            : undefined,
        }}
        noResultsState={{
          title: t('weldpass.projectList.noResultsTitle'),
          description: t('weldpass.projectList.noResultsDescription'),
        }}
      />

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateProjectDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations();
  const createProject = useCreateWeldPassProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setFailure(null);
    try {
      await createProject.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
      });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.projectList.create.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldpass.projectList.create.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-project-name">
              {t('weldpass.projectList.create.name')}
            </Label>
            <Input
              id="weldpass-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('weldpass.projectList.create.namePlaceholder')}
              onKeyDown={(event) => event.key === 'Enter' && void submit()}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="weldpass-project-description">
              {t('weldpass.projectList.create.description')}
            </Label>
            <Input
              id="weldpass-project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('weldpass.projectList.create.descriptionPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('weldpass.projectList.create.descriptionHint')}
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            {t('weldpass.projectList.create.environmentsNote')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('weldpass.secrets.form.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!name.trim() || createProject.isPending}
          >
            {t('weldpass.projectList.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
