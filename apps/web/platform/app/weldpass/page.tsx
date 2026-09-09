/** WeldPass projects — the module's landing page. */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
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
import {
  useCreateWeldPassProject,
  useWeldPassProjects,
} from '@/hooks/queries/use-weldpass-queries';
import { EmptyState, ErrorBanner, InlineSpinner, TimeAgo, errorMessage } from './components/shared';

export default function WeldPassProjectsPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const { data: projects, isLoading, error } = useWeldPassProjects();
  const [creating, setCreating] = useState(false);

  const canCreate = can('secrets:create') || can('secrets:manage');

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t('weldpass.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('weldpass.projectList.subtitle')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldpass.projectList.newProject')}
          </Button>
        )}
      </header>

      <ErrorBanner error={error ? errorMessage(error, t('weldpass.audit.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !projects || projects.length === 0 ? (
        <EmptyState
          title={t('weldpass.projectList.emptyTitle')}
          description={t('weldpass.projectList.emptyDescription')}
          action={
            canCreate ? (
              <Button onClick={() => setCreating(true)}>
                {t('weldpass.projectList.emptyAction')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {projects.map((project) => (
            <Card key={project.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    to="/weldpass/$projectId"
                    params={{ projectId: project.id }}
                    className="text-sm font-medium hover:underline"
                  >
                    {project.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {project.description || project.slug}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-muted-foreground">
                  {t('weldpass.projectList.updated')} <TimeAgo value={project.updatedAt} />
                </p>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {project.environments.map((environment) => (
                  <Link
                    key={environment.id}
                    to="/weldpass/$projectId"
                    params={{ projectId: project.id }}
                    search={{ env: environment.id }}
                  >
                    <Badge variant={environment.isProduction ? 'outline' : 'secondary'}>
                      {environment.name} · {environment.secretCount ?? 0}
                    </Badge>
                  </Link>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
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
