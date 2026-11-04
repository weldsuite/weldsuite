import { useState } from 'react';
import { Archive, LayoutTemplate, MoreHorizontal } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { usePermissions } from '@weldsuite/permissions/react';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useProject } from '@/hooks/queries/use-projects-queries';
import { SaveTemplateDialog } from '@/app/weldflow/templates/_components/save-template-dialog';

/**
 * The project header's action menu:
 * - "Close project", for people who manage the project (the project permission
 *   context's `isAdmin` is the API's `canManageProject`);
 * - "Save as template", for holders of `project_templates:manage` (FLOW-021).
 * Renders nothing for someone who may do neither.
 */
export function ProjectActionsMenu({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const router = useRouter();
  const { isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const canSaveTemplate = can('project_templates:manage');
  const [saving, setSaving] = useState(false);
  const { data: project } = useProject(projectId, canSaveTemplate);
  const copy = t.projects.projectLayout;
  if (!isAdmin && !canSaveTemplate) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copy.projectActions}
            title={copy.projectActions}
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {canSaveTemplate ? (
            <DropdownMenuItem onClick={() => setSaving(true)}>
              <LayoutTemplate className="mr-0.5 h-4 w-4" />
              {t.flowClosing.close.saveAsTemplate}
            </DropdownMenuItem>
          ) : null}
          {isAdmin ? (
            <DropdownMenuItem onClick={() => router.push(`/weldflow/project/${projectId}/close`)}>
              <Archive className="mr-0.5 h-4 w-4" />
              {copy.closeProject}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {canSaveTemplate ? (
        <SaveTemplateDialog
          open={saving}
          onClose={() => setSaving(false)}
          projectId={projectId}
          defaultName={project?.name}
        />
      ) : null}
    </>
  );
}
