/**
 * The module's second header row: the project every analytics page reads.
 * Hidden when the workspace has no project, and on the Projects pages, where
 * the page itself picks the project.
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { useCurrentProject } from '../lib/use-current-project';
import { ProjectKindBadge, ProjectStatusBadge } from './project-badges';

export function ProjectBar() {
  const { t } = useI18n();
  const tb = t.weldpanel.analytics.projectBar;
  const { projects, project, select } = useCurrentProject();
  if (!project) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-4 py-2" data-testid="weldpanel-project-bar">
      <Label htmlFor="weldpanel-project-switcher" className="text-sm text-muted-foreground">
        {tb.label}
      </Label>
      <Select value={project.id} onValueChange={select}>
        <SelectTrigger id="weldpanel-project-switcher" size="sm" className="h-8 w-56 max-w-full">
          <SelectValue placeholder={tb.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="hidden items-center gap-2 sm:flex">
        <ProjectKindBadge kind={project.kind} />
        <ProjectStatusBadge status={project.status} />
      </div>
      <Button asChild variant="ghost" size="sm" className="ml-auto h-8">
        <Link href="/weldpanel/projects">{tb.allProjects}</Link>
      </Button>
    </div>
  );
}
