/**
 * Danger zone: pause or resume collection and rotate the token
 * (`panel_projects:manage`), and delete the project (`panel_projects:delete`).
 * Each action shows only to someone who may do it; the tab itself is hidden
 * from everyone else.
 */

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useDeleteWeldPanelProject,
  useRotateWeldPanelToken,
  useUpdateWeldPanelProjectSettings,
} from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { TypedConfirmDialog } from '../components/typed-confirm-dialog';

interface DangerTabProps {
  project: PanelProjectDto;
  canManage: boolean;
  canDelete: boolean;
}

function Action({ title, description, destructive = false, children }: Readonly<{ title: string; description: string; destructive?: boolean; children: ReactNode }>) {
  return (
    <div className={cn('flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4', destructive && 'border-destructive/40')}>
      <div className="space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function DangerTab({ project, canManage, canDelete }: Readonly<DangerTabProps>) {
  const { t, format } = useI18n();
  const td = t.weldpanel.danger;
  const router = useRouter();
  const updateSettings = useUpdateWeldPanelProjectSettings(project.id);
  const rotate = useRotateWeldPanelToken(project.id);
  const remove = useDeleteWeldPanelProject();
  const [confirming, setConfirming] = useState<'pause' | 'rotate' | 'delete' | null>(null);
  const paused = project.status === 'paused';

  async function resume() {
    try {
      await updateSettings.mutateAsync({ status: 'active' });
      toast.success(td.resume.done);
    } catch {
      toast.error(td.resume.failed);
    }
  }

  async function pause() {
    try {
      await updateSettings.mutateAsync({ status: 'paused' });
      toast.success(td.pause.done);
      setConfirming(null);
    } catch {
      toast.error(td.pause.failed);
    }
  }

  async function rotateToken() {
    try {
      await rotate.mutateAsync();
      toast.success(td.rotate.done);
      setConfirming(null);
    } catch {
      toast.error(td.rotate.failed);
    }
  }

  async function deleteProject() {
    try {
      await remove.mutateAsync(project.id);
      toast.success(td.delete.done);
      setConfirming(null);
      router.push('/weldpanel/projects');
    } catch {
      toast.error(td.delete.failed);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-destructive/30 bg-card p-4 sm:p-5">
      <h2 className="text-base font-medium text-destructive">{td.title}</h2>

      {canManage &&
        (paused ? (
          <Action title={td.resume.title} description={td.resume.description}>
            <Button variant="outline" disabled={updateSettings.isPending} onClick={() => void resume()}>
              {td.resume.button}
            </Button>
          </Action>
        ) : (
          <Action title={td.pause.title} description={td.pause.description}>
            <Button variant="outline" onClick={() => setConfirming('pause')}>
              {td.pause.button}
            </Button>
          </Action>
        ))}

      {canManage && (
        <Action title={td.rotate.title} description={td.rotate.description}>
          <Button variant="outline" onClick={() => setConfirming('rotate')}>
            {td.rotate.button}
          </Button>
        </Action>
      )}

      {canDelete && (
        <Action title={td.delete.title} description={td.delete.description} destructive>
          <Button variant="destructive" onClick={() => setConfirming('delete')}>
            {td.delete.button}
          </Button>
        </Action>
      )}

      <ConfirmDialog
        open={confirming === 'pause'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={td.pause.confirmTitle}
        description={format(td.pause.confirmDescription, { name: project.name })}
        confirmLabel={td.pause.confirm}
        cancelLabel={td.cancel}
        onConfirm={pause}
      />
      <ConfirmDialog
        open={confirming === 'rotate'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={td.rotate.confirmTitle}
        description={format(td.rotate.confirmDescription, { name: project.name })}
        confirmLabel={td.rotate.confirm}
        cancelLabel={td.cancel}
        variant="destructive"
        onConfirm={rotateToken}
      />
      <TypedConfirmDialog
        open={confirming === 'delete'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={format(td.delete.dialogTitle, { name: project.name })}
        description={td.delete.dialogDescription}
        expected={project.name}
        prompt={format(td.delete.confirmLabel, { name: project.name })}
        confirmLabel={td.delete.confirm}
        cancelLabel={td.delete.cancel}
        onConfirm={deleteProject}
      />
    </section>
  );
}
