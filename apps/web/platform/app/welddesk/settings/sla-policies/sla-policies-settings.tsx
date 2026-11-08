/**
 * WeldDesk SLA policies: list, create, edit, switch on or off, delete.
 *
 * Rows: `helpdesk_slas` via `/api/slas` (desk-api). The engine that applies
 * them is `@weldsuite/db/lib/desk-sla` (ADR DESK-009): the first active policy
 * (lowest order) whose conditions match a conversation, else the default.
 */

import { useState } from 'react';
import { Pencil, Plus, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { getTranslations } from '@/lib/i18n';
import {
  useDeleteDeskSla,
  useDeskSlaPolicies,
  useUpdateDeskSla,
  type DeskSlaPolicy,
  type DeskSlaTarget,
} from '@/hooks/queries/use-desk-sla-queries';
import { SlaPolicyEditor } from './sla-policy-editor';

const MINUTES_PER_HOUR = 60;

/** 90 -> "1h 30m", 45 -> "45m", 120 -> "2h". */
function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  return [hours ? `${hours}h` : '', rest || !hours ? `${rest}m` : ''].filter(Boolean).join(' ');
}

/** The target a conversation without a priority is measured against: `medium`. */
function mediumTarget(targets: DeskSlaTarget[]): DeskSlaTarget | undefined {
  return targets.find((target) => target.priority === 'medium' && target.time > 0);
}

export function SlaPoliciesSettings() {
  const t = getTranslations('helpdesk').slaPolicies;
  const canCreate = useCan('slas:create');
  const canUpdate = useCan('slas:update');
  const canDelete = useCan('slas:delete');
  const { data: policies, isLoading, isError, refetch } = useDeskSlaPolicies();
  const updateSla = useUpdateDeskSla();
  const deleteSla = useDeleteDeskSla();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DeskSlaPolicy | null>(null);
  const [deleting, setDeleting] = useState<DeskSlaPolicy | null>(null);

  const openEditor = (policy: DeskSlaPolicy | null) => {
    setEditing(policy);
    setEditorOpen(true);
  };

  const toggleActive = async (policy: DeskSlaPolicy) => {
    try {
      await updateSla.mutateAsync({ id: policy.id, isActive: !policy.isActive });
      toast.success(
        (policy.isActive ? t.toast.deactivated : t.toast.activated).replace('{name}', policy.name),
      );
    } catch {
      toast.error(t.toast.saveFailed);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteSla.mutateAsync(deleting.id);
      toast.success(t.toast.deleted);
      setDeleting(null);
    } catch {
      toast.error(t.toast.deleteFailed);
    }
  };

  const summary = (policy: DeskSlaPolicy): string[] => {
    const parts: string[] = [];
    if (policy.isDefault) parts.push(t.list.fallback);
    else if (policy.conditions.length === 0) parts.push(t.list.matchesAll);
    else parts.push(t.list.conditionCount.replace('{count}', String(policy.conditions.length)));
    const first = mediumTarget(policy.firstResponseTime);
    if (first) parts.push(t.list.firstResponse.replace('{time}', formatMinutes(first.time)));
    const resolution = mediumTarget(policy.resolutionTime);
    if (resolution) parts.push(t.list.resolution.replace('{time}', formatMinutes(resolution.time)));
    // A `business` policy with its own hours counts on those, like `custom` (deskSlaBusinessHours).
    let calendar = t.hours.options.custom.title;
    if (policy.operationalHours === '24x7') calendar = t.hours.options.always.title;
    else if (policy.operationalHours === 'business' && !policy.businessHours) calendar = t.hours.options.workspace.title;
    parts.push(calendar);
    return parts;
  };

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = <ErrorState message={t.loadError} onRetry={() => void refetch()} />;
  } else if (!policies || policies.length === 0) {
    body = (
      <EmptyState
        icon={Timer}
        title={t.empty.title}
        description={t.empty.description}
        action={
          canCreate ? (
            <Button onClick={() => openEditor(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newPolicy}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="sla-policy-list">
        {policies.map((policy, index) => (
          <li
            key={policy.id}
            className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap"
            data-testid="sla-policy-row"
          >
            <span
              className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground"
              title={t.list.orderTitle}
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{policy.name}</span>
                {policy.isDefault && <SoftBadge tone="success">{t.list.defaultBadge}</SoftBadge>}
                {!policy.isActive && <SoftBadge tone="neutral">{t.list.inactiveBadge}</SoftBadge>}
              </div>
              <p className="text-sm text-muted-foreground">{summary(policy).join(' · ')}</p>
              {policy.description && <p className="truncate text-xs text-muted-foreground">{policy.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Switch
                checked={policy.isActive}
                disabled={!canUpdate || updateSla.isPending}
                onCheckedChange={() => void toggleActive(policy)}
                aria-label={t.list.activeToggle.replace('{name}', policy.name)}
              />
              {canUpdate && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openEditor(policy)}
                  aria-label={t.list.edit.replace('{name}', policy.name)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleting(policy)}
                  aria-label={t.list.delete.replace('{name}', policy.name)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6" data-testid="sla-policies-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          {canCreate && policies && policies.length > 0 && (
            <Button onClick={() => openEditor(null)} data-testid="sla-policy-new">
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newPolicy}
            </Button>
          )}
        </div>

        <InfoBanner variant="info">{t.appliesNote}</InfoBanner>
        {body}
      </div>

      <SlaPolicyEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        policy={editing}
        policies={policies ?? []}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.delete.title}
        description={t.delete.description.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.delete.confirm}
        variant="destructive"
        loading={deleteSla.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
