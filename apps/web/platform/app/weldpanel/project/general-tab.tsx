/**
 * General tab: name, type and allowed domains (`panel_projects:update`).
 * Without that permission the values are shown, with no controls.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Form } from '@weldsuite/ui/components/form';
import type { PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';
import { useUpdateWeldPanelProject } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectFields } from '../components/project-fields';
import { ReadOnlyChips, ReadOnlyField } from '../components/read-only-field';
import { projectChanges, projectFormValues } from '../lib/changes';
import { buildProjectFormSchema, type ProjectFormValues } from '../lib/validation';

interface GeneralTabProps {
  project: PanelProjectDto;
  canUpdate: boolean;
}

export function GeneralTab({ project, canUpdate }: Readonly<GeneralTabProps>) {
  const { t } = useI18n();
  const tg = t.weldpanel.general;

  return (
    <section className="space-y-5 rounded-lg border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-base font-medium">{tg.title}</h2>
        <p className="text-sm text-muted-foreground">{tg.description}</p>
      </div>
      {canUpdate ? (
        // Keyed by the server's version, so a save (or a colleague's change) starts the form from what is stored.
        <GeneralForm key={project.updatedAt} project={project} />
      ) : (
        <dl className="space-y-4">
          <ReadOnlyField label={tg.nameLabel}>{project.name}</ReadOnlyField>
          <ReadOnlyField label={tg.kindLabel}>{t.weldpanel.kinds[project.kind]}</ReadOnlyField>
          <ReadOnlyField label={tg.domainsLabel}>
            <ReadOnlyChips values={project.allowedDomains} empty={tg.anySite} />
          </ReadOnlyField>
        </dl>
      )}
    </section>
  );
}

function GeneralForm({ project }: Readonly<{ project: PanelProjectDto }>) {
  const { t } = useI18n();
  const tg = t.weldpanel.general;
  const update = useUpdateWeldPanelProject(project.id);
  const schema = useMemo(() => buildProjectFormSchema(t.weldpanel.validation), [t.weldpanel.validation]);
  const form = useForm<ProjectFormValues>({ resolver: zodResolver(schema), defaultValues: projectFormValues(project) });

  const submit = form.handleSubmit(async (values) => {
    const changes = projectChanges(values, project);
    if (Object.keys(changes).length === 0) return;
    try {
      await update.mutateAsync(changes);
      // The saved values are the new baseline (the remount on a new `updatedAt` does the same).
      form.reset(values);
      toast.success(tg.saved);
    } catch {
      toast.error(tg.saveFailed);
    }
  });

  const saving = update.isPending;

  return (
    <Form {...form}>
      <form onSubmit={submit} noValidate className="space-y-5">
        <ProjectFields form={form} domainsHint={tg.domainsHint} disabled={saving} />
        <Button type="submit" disabled={saving || !form.formState.isDirty}>
          {saving && <Loader2 className="animate-spin" />}
          {saving ? tg.saving : tg.save}
        </Button>
      </form>
    </Form>
  );
}
