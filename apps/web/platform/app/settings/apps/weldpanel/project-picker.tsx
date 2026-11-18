/**
 * The project the Exports tab works on. Inside WeldPanel the module header's
 * switcher (`ProjectBar`) picks it; Settings has no module header, so the tab
 * shows its own picker on the same shared choice (`useCurrentProject`).
 */

import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentProject } from '@/app/weldpanel/lib/use-current-project';

export function ProjectPicker() {
  const { t } = useI18n();
  const tb = t.weldpanel.analytics.projectBar;
  const { projects, project, select } = useCurrentProject();
  if (!project) return null;

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="weldpanel-settings-project">
      <Label htmlFor="weldpanel-settings-project" className="text-sm text-muted-foreground">
        {tb.label}
      </Label>
      <Select value={project.id} onValueChange={select}>
        <SelectTrigger id="weldpanel-settings-project" size="sm" className="h-8 w-56 max-w-full">
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
    </div>
  );
}
