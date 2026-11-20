/**
 * WeldDesk priority matrix: ITIL impact × urgency → priority, and whether the
 * inbox applies it. `helpdesk_settings.tickets.priorityMatrix` via
 * `/api/helpdesk-settings/priority-matrix` (desk-api); the inbox applies it in
 * `updateDeskConversationAttributes` (`@weldsuite/db/lib/desk-priority-matrix`).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingRow, SettingsPage, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DESK_LEVELS,
  DESK_PRIORITIES,
  type DeskLevel,
  type DeskPriority,
  type DeskPriorityMatrix,
} from '@/hooks/queries/use-desk-queries';
import {
  DEFAULT_DESK_PRIORITY_MATRIX,
  useDeskPriorityMatrix,
  useSaveDeskPriorityMatrix,
} from '@/hooks/queries/use-desk-priority-matrix-queries';
import { PRIORITY_DOT } from '@/app/welddesk/inbox/ticket-fields';

/** Urgency runs left to right from low, impact top to bottom from high. */
const URGENCY_COLUMNS: DeskLevel[] = ['low', 'medium', 'high'];

function sameMatrix(a: DeskPriorityMatrix, b: DeskPriorityMatrix): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function PriorityMatrixSettings() {
  const t = getTranslations('helpdesk').priorityMatrix;
  const priorities = getTranslations('deskInbox2').ticket.priorities;
  const canUpdate = useCan('welddesk:settings:update');
  const { data, isLoading, isError, refetch } = useDeskPriorityMatrix();
  const save = useSaveDeskPriorityMatrix();
  const [draft, setDraft] = useState<DeskPriorityMatrix | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (isError || !data || !draft) return <ErrorState message={t.loadError} onRetry={() => void refetch()} />;

  const setCell = (impact: DeskLevel, urgency: DeskLevel, priority: DeskPriority) =>
    setDraft({
      ...draft,
      matrix: { ...draft.matrix, [impact]: { ...draft.matrix[impact], [urgency]: priority } },
    });

  const onSave = () =>
    save.mutate(draft, {
      onSuccess: () => toast.success(t.saved),
      onError: () => toast.error(t.saveError),
    });

  return (
    <SettingsPage
      title={t.title}
      description={t.description}
      hasChanges={canUpdate && !sameMatrix(draft, data)}
      saving={save.isPending}
      onSave={onSave}
      onCancel={() => setDraft(data)}
      saveLabel={t.save}
    >
      <SettingsSection title={t.title}>
        <SettingRow label={t.enabled} description={t.enabledHint}>
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            disabled={!canUpdate}
            aria-label={t.enabled}
            data-testid="desk-priority-matrix-enabled"
          />
        </SettingRow>

        <div className="overflow-x-auto">
          <table className="w-full max-w-xl border-separate border-spacing-2 text-sm" data-testid="desk-priority-matrix-grid">
            <thead>
              <tr>
                <th scope="col" className="text-left text-xs font-medium text-muted-foreground">
                  {t.impactUrgency}
                </th>
                {URGENCY_COLUMNS.map((urgency) => (
                  <th key={urgency} scope="col" className="text-left text-xs font-medium text-muted-foreground">
                    {t.urgency}: {t.levels[urgency]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DESK_LEVELS.map((impact) => (
                <tr key={impact}>
                  <th scope="row" className="text-left text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {t.impact}: {t.levels[impact]}
                  </th>
                  {URGENCY_COLUMNS.map((urgency) => (
                    <td key={urgency}>
                      <Select
                        value={draft.matrix[impact][urgency]}
                        onValueChange={(value) => setCell(impact, urgency, value as DeskPriority)}
                        disabled={!canUpdate}
                      >
                        <SelectTrigger
                          className="h-8 w-full min-w-[110px] text-sm"
                          aria-label={`${t.impact} ${t.levels[impact]}, ${t.urgency} ${t.levels[urgency]}`}
                          data-testid={`desk-priority-matrix-${impact}-${urgency}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DESK_PRIORITIES.map((priority) => (
                            <SelectItem key={priority} value={priority}>
                              <span className="inline-flex items-center gap-2">
                                <span className={cn('h-2 w-2 rounded-full', PRIORITY_DOT[priority])} />
                                {priorities[priority]}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canUpdate && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft({ ...draft, matrix: DEFAULT_DESK_PRIORITY_MATRIX })}
          >
            {t.resetDefault}
          </Button>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
