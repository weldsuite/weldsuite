/**
 * The actions on one alert (history, edit, test, snooze, turn on or off,
 * delete) as `DropdownMenuItem`s: the list's row menu and the "⋮" menu of the
 * alert's record panel.
 */

import { toast } from 'sonner';
import type { PanelAlertDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useSnoozeWeldPanelAlert, useTestWeldPanelAlert, useUpdateWeldPanelAlert } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { deliveryReportText } from '../components/delivery-channels-fields';
import { daysFromNow } from '../lib/date-input';

const HOUR_MS = 3_600_000;

export interface AlertMenuItemsProps {
  alert: PanelAlertDto;
  canChange: boolean;
  canDelete: boolean;
  /** Opens the alert's history; left out where it is already open (its own panel). */
  onOpen?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function AlertMenuItems({ alert, canChange, canDelete, onOpen, onEdit, onDelete }: Readonly<AlertMenuItemsProps>) {
  const { t, format } = useI18n();
  const ta = t.weldpanel.collab.alerts;
  const tch = t.weldpanel.collab.channels.delivery;
  const update = useUpdateWeldPanelAlert();
  const snooze = useSnoozeWeldPanelAlert();
  const test = useTestWeldPanelAlert();
  const snoozed = alert.snoozedUntil !== null && Date.parse(alert.snoozedUntil) > Date.now();

  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      toast.success(done);
    } catch {
      toast.error(ta.failed);
    }
  }

  async function sendTest() {
    try {
      const report = await test.mutateAsync(alert.id);
      toast.success(ta.tested, {
        description: deliveryReportText(report, tch, format),
      });
    } catch {
      toast.error(ta.testFailed);
    }
  }

  return (
    <>
      {onOpen && <DropdownMenuItem onSelect={onOpen}>{ta.actions.history}</DropdownMenuItem>}
      {canChange && (
        <>
          <DropdownMenuItem onSelect={onEdit}>{ta.actions.edit}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void sendTest()}>{ta.actions.test}</DropdownMenuItem>
          {snoozed ? (
            <DropdownMenuItem onSelect={() => void run(() => snooze.mutateAsync({ id: alert.id, until: null }), ta.unsnoozedToast)}>{ta.actions.unsnooze}</DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{ta.actions.snooze}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        snooze.mutateAsync({
                          id: alert.id,
                          until: new Date(Date.now() + HOUR_MS).toISOString(),
                        }),
                      ta.snoozedToast,
                    )
                  }
                >
                  {ta.actions.snooze1h}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        snooze.mutateAsync({
                          id: alert.id,
                          until: daysFromNow(1),
                        }),
                      ta.snoozedToast,
                    )
                  }
                >
                  {ta.actions.snooze1d}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(
                      () =>
                        snooze.mutateAsync({
                          id: alert.id,
                          until: daysFromNow(7),
                        }),
                      ta.snoozedToast,
                    )
                  }
                >
                  {ta.actions.snooze1w}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            onSelect={() =>
              void run(
                () =>
                  update.mutateAsync({
                    id: alert.id,
                    enabled: !alert.enabled,
                  }),
                alert.enabled ? ta.disabledToast : ta.enabledToast,
              )
            }
          >
            {alert.enabled ? ta.actions.disable : ta.actions.enable}
          </DropdownMenuItem>
        </>
      )}
      {canDelete && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
            {ta.actions.delete}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
