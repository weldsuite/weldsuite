/**
 * WeldDesk routing rules: the ordered list (move up / down, switch on or off,
 * edit, delete) and the rule editor. Every change saves the whole list
 * (`PUT /api/desk/routing`, desk-api); the engine is
 * `@weldsuite/db/lib/desk-routing`.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Route, Trash2 } from 'lucide-react';
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
import { useDeskAttributeOptions } from '@/hooks/queries/use-desk-queries';
import {
  useDeskRoutingRules,
  useDeskTeamMembers,
  useDeskTeams,
  useSaveDeskRoutingRules,
  type DeskRoutingRule,
} from '@/hooks/queries/use-desk-routing-queries';
import { RoutingRuleEditor, type RoutingOptions } from './routing-rule-editor';
import {
  moveRule,
  newRuleId,
  ruleSummary,
  valuesToRule,
  type RoutingChannel,
  type RoutingFormValues,
  type RoutingPriority,
} from './routing-form';

export function RoutingSettings() {
  const t = getTranslations('helpdesk').routing;
  const canEdit = useCan('welddesk:settings:update');
  const { data: rules, isLoading, isError, refetch } = useDeskRoutingRules();
  const { data: teams = [] } = useDeskTeams();
  const { data: members = [] } = useDeskTeamMembers();
  const { data: attributes } = useDeskAttributeOptions();
  const save = useSaveDeskRoutingRules();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DeskRoutingRule | null>(null);
  const [deleting, setDeleting] = useState<DeskRoutingRule | null>(null);

  const options: RoutingOptions = useMemo(
    () => ({
      ticketTypes: (attributes?.ticketTypes ?? []).map((type) => ({ value: type.id, label: type.name })),
      teams: teams.filter((team) => team.isActive).map((team) => ({ value: team.id, label: team.name })),
      members: members.map((member) => ({ value: member.userId, label: member.name })),
      tags: (attributes?.tags ?? []).map((tag) => tag.tag),
    }),
    [attributes, teams, members],
  );

  const names = useMemo(() => {
    const typeName = new Map((attributes?.ticketTypes ?? []).map((type) => [type.id, type.name]));
    const teamName = new Map(teams.map((team) => [team.id, team.name]));
    const memberName = new Map(members.map((member) => [member.userId, member.name]));
    return {
      channel: (id: string) => t.channels[id as RoutingChannel] ?? id,
      priority: (id: string) => t.priorities[id as RoutingPriority] ?? id,
      type: (id: string) => typeName.get(id) ?? id,
      team: (id: string) => teamName.get(id) ?? id,
      member: (id: string) => memberName.get(id) ?? id,
    };
  }, [attributes, teams, members, t]);

  const persist = async (next: DeskRoutingRule[], success: string): Promise<boolean> => {
    try {
      await save.mutateAsync(next);
      toast.success(success);
      return true;
    } catch {
      toast.error(t.toast.saveFailed);
      return false;
    }
  };

  const list = rules ?? [];

  const onSave = (values: RoutingFormValues) => {
    if (editing) {
      const rule = valuesToRule(editing.id, values);
      return persist(
        list.map((r) => (r.id === editing.id ? rule : r)),
        t.toast.saved,
      );
    }
    return persist([...list, valuesToRule(newRuleId(list), values)], t.toast.saved);
  };

  const openEditor = (rule: DeskRoutingRule | null) => {
    setEditing(rule);
    setEditorOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    if (await persist(list.filter((r) => r.id !== deleting.id), t.toast.deleted)) setDeleting(null);
  };

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = <ErrorState message={t.loadError} onRetry={() => void refetch()} />;
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon={Route}
        title={t.empty.title}
        description={t.empty.description}
        action={
          canEdit ? (
            <Button onClick={() => openEditor(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newRule}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="routing-rule-list">
        {list.map((rule, index) => {
          const summary = ruleSummary(rule, t, names);
          return (
            <li key={rule.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap" data-testid="routing-rule-row">
              <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground" title={t.list.orderTitle}>
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{rule.name}</span>
                  {!rule.enabled && <SoftBadge tone="neutral">{t.list.disabledBadge}</SoftBadge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {summary.when} {t.summary.then} {summary.then}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canEdit && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={index === 0 || save.isPending}
                      onClick={() => void persist(moveRule(list, index, -1), t.toast.saved)}
                      aria-label={t.list.moveUp.replace('{name}', rule.name)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={index === list.length - 1 || save.isPending}
                      onClick={() => void persist(moveRule(list, index, 1), t.toast.saved)}
                      aria-label={t.list.moveDown.replace('{name}', rule.name)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <Switch
                  checked={rule.enabled}
                  disabled={!canEdit || save.isPending}
                  onCheckedChange={(on) =>
                    void persist(
                      list.map((r) => (r.id === rule.id ? { ...r, enabled: on } : r)),
                      t.toast.saved,
                    )
                  }
                  aria-label={t.list.enabledToggle.replace('{name}', rule.name)}
                />
                {canEdit && (
                  <>
                    <Button variant="ghost" size="icon" onClick={() => openEditor(rule)} aria-label={t.list.edit.replace('{name}', rule.name)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(rule)} aria-label={t.list.delete.replace('{name}', rule.name)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6" data-testid="routing-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          {canEdit && list.length > 0 && (
            <Button onClick={() => openEditor(null)} data-testid="routing-rule-new">
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newRule}
            </Button>
          )}
        </div>

        <InfoBanner variant="info">{t.appliesNote}</InfoBanner>
        {body}
      </div>

      <RoutingRuleEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rule={editing}
        options={options}
        saving={save.isPending}
        onSave={onSave}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.delete.title}
        description={t.delete.description.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.delete.confirm}
        variant="destructive"
        loading={save.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
