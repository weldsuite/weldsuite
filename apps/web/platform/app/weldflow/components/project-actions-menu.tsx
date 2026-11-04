import { Archive, MoreHorizontal } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';

/**
 * The project header's action menu. Today it holds "Close project", which
 * only people who manage the project see (the project permission context's
 * `isAdmin` is the API's `canManageProject`). Renders nothing for everyone else.
 */
export function ProjectActionsMenu({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const router = useRouter();
  const { isAdmin } = useProjectPermissions();
  const copy = t.projects.projectLayout;
  if (!isAdmin) return null;

  return (
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
        <DropdownMenuItem onClick={() => router.push(`/weldflow/project/${projectId}/close`)}>
          <Archive className="mr-0.5 h-4 w-4" />
          {copy.closeProject}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
