import { useState } from 'react';
import { AlertCircle, Flag } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { usePermissions } from '@weldsuite/permissions/react';
import { useParams } from '@/lib/router';
import { useUser } from '@/lib/auth';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { usePhaseGate, usePhases, useProjectSchedule } from '@/hooks/queries/use-project-schedule-queries';
import { fill } from '../dependencies/_lib/format';
import { GateCard } from './_components/gate-card';
import { Lifecycle } from './_components/lifecycle';
import { PastGates } from './_components/past-gates';
import { PhaseEditor, type DecisionOption } from './_components/phase-editor';

/**
 * The project's decisions, for the "decision decided" criterion. Optional data (the decision log is another
 * screen's API): a failure leaves the list empty.
 */
function useDecisionOptions(projectId: string, enabled: boolean) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: ['project-schedule', 'decision-options', projectId],
    queryFn: async (): Promise<DecisionOption[]> => {
      try {
        const client = await getClient();
        const res = await client.get<{ data: Array<{ id: string; code?: string; title: string }> }>(`/project-decisions?projectId=${encodeURIComponent(projectId)}&limit=100`);
        return res.data.map((decision) => ({ id: decision.id, label: `${decision.code ?? ''} ${decision.title}`.trim() }));
      } catch {
        return [];
      }
    },
    enabled: enabled && !!projectId,
    staleTime: 60_000,
  });
}

function LoadingState() {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" aria-label={t.flowSchedule.phases.title} className="grid gap-4">
      <Skeleton className="h-36 rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-96 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
    </div>
  );
}

/** Gantt, Phases and gates: the lifecycle, the next gate with its criteria, who approves, and the gates that passed. */
export default function PhasesPage() {
  const { t } = useI18n();
  const copy = t.flowSchedule.phases;
  const params = useParams();
  const projectId = params.projectId as string;
  const { user } = useUser();
  const { canWrite, isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const canManage = isAdmin && can('projects:update');
  const [editing, setEditing] = useState(false);

  const phases = usePhases(projectId);
  const schedule = useProjectSchedule(projectId, canManage);
  const decisions = useDecisionOptions(projectId, editing);
  const activeId = phases.data?.phases.find((phase) => phase.status === 'active')?.id ?? null;
  const gate = usePhaseGate(activeId);

  if (phases.isLoading) return <LoadingState />;
  if (phases.isError || !phases.data) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
        <div className="rounded-full bg-muted p-3">
          <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
        </div>
        <h2 className="text-base font-semibold">{copy.states.loadFailedTitle}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{copy.states.loadFailedDescription}</p>
        <Button type="button" variant="outline" onClick={() => void phases.refetch()}>
          {copy.states.retry}
        </Button>
      </div>
    );
  }

  const list = phases.data.phases;
  const active = list.find((phase) => phase.id === activeId);
  const next = active ? list[list.indexOf(active) + 1] : undefined;
  const sponsorId = gate.data?.approverIds[0];
  const isSponsor = !!user?.id && sponsorId === user.id;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">{copy.lifecycle}</h2>
        {list.length > 0 && <span className="text-sm text-muted-foreground">{fill(copy.lifecycleSummary, { phases: list.length, gates: list.length })}</span>}
        <div className="flex-1" />
        {canManage && (
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            {copy.editPhases}
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
          <div className="rounded-full bg-muted p-3">
            <Flag aria-hidden className="size-6 text-muted-foreground" />
          </div>
          <h2 className="text-base font-semibold">{copy.gate.noPhases}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{canManage ? copy.gate.noPhasesDescription : copy.gate.readOnly}</p>
          {canManage && (
            <Button type="button" onClick={() => setEditing(true)}>
              {copy.editor.add}
            </Button>
          )}
        </div>
      ) : (
        <>
          <Lifecycle phases={list} />
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            {gate.data ? (
              <GateCard projectId={projectId} gate={gate.data} nextName={next?.name ?? null} canManage={canManage && canWrite} isSponsor={isSponsor} />
            ) : gate.isLoading ? (
              <Skeleton className="h-96 rounded-lg" />
            ) : (
              <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{copy.gate.allPassed}</p>
            )}
            <PastGates phases={list} />
          </div>
        </>
      )}

      {canManage && (
        <PhaseEditor
          open={editing}
          onOpenChange={setEditing}
          projectId={projectId}
          phases={list}
          deliverables={schedule.data?.deliverables ?? []}
          decisions={decisions.data ?? []}
        />
      )}
    </div>
  );
}
