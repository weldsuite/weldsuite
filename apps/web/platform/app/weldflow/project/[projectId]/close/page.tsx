import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, LayoutTemplate } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import type { CloseChecklist } from '@weldsuite/app-api-client/domains/project-closing';
import { Button } from '@weldsuite/ui/components/button';
import { Link, useParams } from '@/lib/router';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/provider';
import { useCloseChecklist } from '@/hooks/queries/use-project-closing-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { SaveTemplateDialog } from '@/app/weldflow/templates/_components/save-template-dialog';
import { CloseContext, type CloseAbilities, type CloseContextValue } from './_components/close-context';
import { CloseErrorState, CloseLoadingState } from './_components/close-states';
import { ChecklistCard } from './_components/checklist-card';
import { BenefitsCard } from './_components/benefits-card';
import { FinanceCard } from './_components/finance-card';
import { LessonsBoard } from './_components/lessons-board';
import { SignOffCard } from './_components/signoff-card';
import { formatDay } from './_lib/close';
import { useMemberDirectory } from './_lib/members';

function useAbilities(closed: boolean): CloseAbilities {
  const { canWrite, isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const open = canWrite && !closed;
  return {
    manage: isAdmin && can('projects:update') && !closed,
    addLessons: open && can('projects:create'),
    voteLessons: open && can('projects:update'),
    editLessons: open && can('projects:update'),
    deleteLessons: open && can('projects:delete'),
    publishLessons: open && can('projects:update') && can('knowledge:create'),
    saveTemplate: can('project_templates:manage'),
  };
}

function Progress({ progress }: Readonly<{ progress: CloseChecklist['progress'] }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.close.progress;
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <div className="min-w-[14rem]">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{copy.label}</span>
        <span className="font-semibold text-foreground">{format(copy.value, progress)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={format(copy.aria, progress)}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** The page once the checklist is loaded. Exported for tests; the route renders `CloseProjectPage`. */
export function CloseContent({ projectId, checklist }: Readonly<{ projectId: string; checklist: CloseChecklist }>) {
  const { t, language, format } = useI18n();
  const copy = t.flowClosing.close;
  const { userId } = useAuth();
  const { isAdmin } = useProjectPermissions();
  const abilities = useAbilities(checklist.closed);
  const { members, memberOf } = useMemberDirectory();
  const [saving, setSaving] = useState(false);

  const value = useMemo<CloseContextValue>(
    () => ({ projectId, checklist, userId: userId ?? null, isManager: isAdmin, abilities, members, memberOf }),
    [projectId, checklist, userId, isAdmin, abilities, members, memberOf],
  );

  return (
    <CloseContext.Provider value={value}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-[1_1_22rem]">
            <Link href={`/weldflow/project/${projectId}`} className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
              <ArrowLeft aria-hidden className="size-3.5" />
              {copy.backToProject}
            </Link>
            <h2 className="mt-1.5 text-xl font-semibold">{copy.title}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">{copy.description}</p>
          </div>
          {abilities.saveTemplate ? (
            <Button type="button" variant="outline" onClick={() => setSaving(true)}>
              <LayoutTemplate aria-hidden />
              {copy.saveAsTemplate}
            </Button>
          ) : null}
          <Progress progress={checklist.progress} />
        </div>

        {checklist.closed ? (
          <div role="status" className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-3.5 dark:border-green-900 dark:bg-green-950/30">
            <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-green-700 dark:text-green-400" />
            <div className="text-sm">
              <p className="font-semibold">{copy.closedBanner.title}</p>
              <p className="text-muted-foreground">
                {checklist.closedAt ? `${format(copy.closedBanner.onDate, { date: formatDay(checklist.closedAt, intlLocaleOf(language)) })} ` : ''}
                {copy.closedBanner.readOnly}
              </p>
            </div>
          </div>
        ) : null}

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <ChecklistCard />
          <div className="flex min-w-0 flex-col gap-4">
            <BenefitsCard />
            <FinanceCard />
          </div>
        </div>
        <LessonsBoard />
        <SignOffCard />
      </div>
      <SaveTemplateDialog open={saving} onClose={() => setSaving(false)} projectId={projectId} defaultName={checklist.projectName} />
    </CloseContext.Provider>
  );
}

/** Close project: the checklist, the final benefits and finance, the lessons learned and the sponsor's sign-off. */
export default function CloseProjectPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const query = useCloseChecklist(projectId);

  let body: ReactNode;
  if (query.isLoading) {
    body = <CloseLoadingState />;
  } else if (query.isError || !query.data) {
    body = <CloseErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else {
    body = <CloseContent key={projectId} projectId={projectId} checklist={query.data} />;
  }

  return (
    <div className="mx-auto w-full max-w-[90rem] px-3 pb-10 md:px-4">
      {body}
    </div>
  );
}
