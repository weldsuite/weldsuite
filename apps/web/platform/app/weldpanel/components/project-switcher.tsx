/**
 * The project every WeldPanel analytics page reads, picked at the top of the
 * module sidebar, the same switcher as WeldBooks' legal entity. Hidden where
 * analytics aren't offered (the Kubernetes editions) and while the workspace
 * has no project; "New project" opens the create dialog for whoever may
 * create one.
 */

import { useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { SidebarScopeSwitcher, type ScopeOption } from '@/components/layout/sidebar-scope-switcher';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentProject } from '../lib/use-current-project';
import { CreateProjectDialog } from './create-project-dialog';

export function WeldPanelProjectSwitcher() {
  const { t } = useI18n();
  const canCreate = useCan('panel_projects:create');
  const { projects, project, select } = useCurrentProject();
  const [createOpen, setCreateOpen] = useState(false);

  if (!isFeatureAvailable('panel-analytics') || !project) return null;

  // Second line: what it tracks and whether it collects, e.g. "Website · Active".
  const options: ScopeOption[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: `${t.weldpanel.kinds[p.kind]} · ${t.weldpanel.statuses[p.status]}`,
  }));

  return (
    <>
      <SidebarScopeSwitcher
        options={options}
        currentId={project.id}
        onSelect={select}
        label={t.weldpanel.analytics.projectBar.label}
        placeholder={t.weldpanel.analytics.projectBar.placeholder}
        addLabel={canCreate ? t.weldpanel.projects.newProject : undefined}
        onAdd={canCreate ? () => setCreateOpen(true) : undefined}
      />
      {canCreate && <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </>
  );
}
