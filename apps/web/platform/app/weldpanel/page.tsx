import { ChartSpline, Code, Plus, PlayCircle, Filter } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';

/**
 * WeldPanel home. Phase 0 of docs/plans/weldpanel.md: the module is registered
 * but panel-api has no project routes yet, so this is the empty state only.
 * Creating a project and the install snippet replace it in phase 1, the
 * Overview dashboard in phase 2.
 */
export default function WeldPanelHome() {
  const { t } = useI18n();
  const th = t.weldpanel.home;
  const canCreate = useCan('panel_projects:create');

  const steps = [
    { icon: Code, ...th.steps.install },
    { icon: Filter, ...th.steps.analyse },
    { icon: PlayCircle, ...th.steps.watch },
  ];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{th.title}</h1>
          <p className="text-sm text-muted-foreground">{th.description}</p>
        </div>
        {canCreate && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{th.comingSoon}</span>
            <Button size="sm" disabled>
              <Plus />
              {th.newProject}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center">
        <ChartSpline className="size-8 text-muted-foreground" />
        <p className="font-medium">{th.emptyTitle}</p>
        <p className="max-w-md text-sm text-muted-foreground">{th.emptyDescription}</p>
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
    </div>
  );
}
