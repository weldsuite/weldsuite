import { useMemo, useState, type ComponentProps } from 'react';
import { useAuth } from '@/lib/auth';
import { Loader2, Plus } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import type { ChangeRequestStatusValue } from '@weldsuite/app-api-client/domains/flow-approvals';
import { cn } from '@/lib/utils';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useChangeControl, useChangeRequest, useChangeRequests } from '@/hooks/queries/use-flow-approvals-queries';
import { useProjectMembers } from '@/hooks/queries/use-projects-queries';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useMemberNames, type MemberOption } from '@/app/weldflow/_approvals/use-member-names';
import { ChangeDetail } from './_components/change-detail';
import { ChangeDialog } from './_components/change-dialog';
import { RulesCard } from './_components/rules-card';

const STATUSES: readonly ChangeRequestStatusValue[] = ['draft', 'assessing', 'awaiting_approval', 'approved', 'rejected', 'implemented', 'withdrawn'];

function Message({ text, action }: Readonly<{ text: string; action?: { label: string; onClick: () => void } }>) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-muted-foreground">
      <p>{text}</p>
      {action ? (
        <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-12" role="status">
      <Loader2 className="animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}

function ChangeListPane({
  changes,
  visible,
  filtered,
  selectedId,
  onSelect,
}: Readonly<{
  changes: ReturnType<typeof useChangeRequests>;
  visible: NonNullable<ReturnType<typeof useChangeRequests>['data']>;
  filtered: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes;
  if (changes.isLoading) return <Spinner />;
  if (changes.isError) return <Message text={copy.loadFailed} action={{ label: t.flowApprovals.common.retry, onClick: () => void changes.refetch() }} />;
  if (visible.length === 0) return <Message text={filtered ? copy.emptyFiltered : copy.empty} />;
  return (
    <ul>
      {visible.map((change) => (
        <li key={change.id}>
          <button
            type="button"
            onClick={() => onSelect(change.id)}
            aria-current={change.id === selectedId ? 'true' : undefined}
            className={cn('flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left text-sm last:border-b-0 hover:bg-muted/50', change.id === selectedId && 'bg-muted')}
          >
            <span className="text-xs text-muted-foreground">
              {change.code} · {copy.status[change.status]}
            </span>
            <span className="font-medium">{change.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChangeDetailPane({
  selectedId,
  detail,
  ...detailProps
}: Readonly<
  { selectedId: string | null; detail: ReturnType<typeof useChangeRequest> } & Omit<ComponentProps<typeof ChangeDetail>, 'change'>
>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes;
  if (!selectedId) return <Message text={copy.selectOne} />;
  if (detail.isLoading) return <Spinner />;
  if (detail.data) return <ChangeDetail change={detail.data} {...detailProps} />;
  return <Message text={copy.loadFailed} action={{ label: t.flowApprovals.common.retry, onClick: () => void detail.refetch() }} />;
}

/** Governance > Change requests: the approval rules, the list per status and the detail of one change. */
export default function ChangeRequestsPage() {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes;
  const params = useParams();
  const projectId = params.projectId as string;
  const { userId } = useAuth();
  const { can } = usePermissions();
  const { canWrite, isAdmin } = useProjectPermissions();
  const { nameOf } = useMemberNames();

  const control = useChangeControl(projectId);
  const changes = useChangeRequests(projectId);
  const projectMembers = useProjectMembers(projectId);
  const [status, setStatus] = useState<ChangeRequestStatusValue | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const detail = useChangeRequest(selectedId);

  const members = useMemo<MemberOption[]>(
    () => (projectMembers.data?.data ?? []).map((member) => ({ userId: member.userId, name: member.user?.name || member.user?.email || member.userId })),
    [projectMembers.data],
  );
  const counts = useMemo(() => {
    const out = new Map<ChangeRequestStatusValue, number>();
    for (const change of changes.data ?? []) out.set(change.status, (out.get(change.status) ?? 0) + 1);
    return out;
  }, [changes.data]);
  const visible = (changes.data ?? []).filter((change) => !status || change.status === status);
  const abilities = { write: canWrite && can('projects:update'), remove: can('projects:delete'), manage: isAdmin };
  const currency = control.data?.currency ?? null;

  return (
    <div className="space-y-4 p-4" data-testid="change-requests">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        {canWrite && can('projects:create') ? (
          <Button size="sm" onClick={() => setDialog('create')}>
            <Plus aria-hidden />
            {copy.new}
          </Button>
        ) : null}
      </div>

      {control.data ? <RulesCard projectId={projectId} control={control.data} members={members} canEdit={isAdmin && can('projects:update')} /> : null}

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={copy.title}>
        <button type="button" aria-pressed={!status} onClick={() => setStatus(null)} className={cn('rounded-full border px-3 py-1 text-xs', !status ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}>
          {copy.all} {changes.data?.length ?? 0}
        </button>
        {STATUSES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={status === candidate}
            onClick={() => setStatus(status === candidate ? null : candidate)}
            className={cn('rounded-full border px-3 py-1 text-xs', status === candidate ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
          >
            {copy.status[candidate]} {counts.get(candidate) ?? 0}
          </button>
        ))}
      </div>

      <div className="grid min-h-[24rem] gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="rounded-lg border">
          <ChangeListPane changes={changes} visible={visible} filtered={!!status} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <div className="min-h-[24rem] rounded-lg border">
          <ChangeDetailPane
            selectedId={selectedId}
            detail={detail}
            currency={currency}
            abilities={abilities}
            userId={userId}
            nameOf={nameOf}
            onEdit={() => setDialog('edit')}
            onDeleted={() => setSelectedId(null)}
          />
        </div>
      </div>

      <ChangeDialog
        projectId={projectId}
        currency={currency}
        change={dialog === 'edit' ? (detail.data ?? null) : null}
        open={dialog !== null}
        onOpenChange={(open) => setDialog(open ? dialog : null)}
        onSaved={(id) => setSelectedId(id)}
      />
    </div>
  );
}
