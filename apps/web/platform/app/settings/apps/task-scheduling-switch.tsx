import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { useUserPreferences, useUpdateUserPreferences } from '@/hooks/queries/use-settings-queries';
import { calendarKeys } from '@/hooks/queries/use-calendar-queries';
import { getTranslations } from '@/lib/i18n';

/**
 * Task scheduling switches, stored per user in `uiPreferences` (absent = on):
 * - `autoScheduleFlowTasks` / `autoScheduleCrmTasks` (WeldFlow / WeldCRM):
 *   place that app's tasks in free calendar slots. Turning one off clears the
 *   blocks already placed for its tasks. Absent falls back to the legacy
 *   `autoScheduleTasks` both apps shared.
 * - `autoRescheduleTasks` (WeldCalendar): the nightly replan, which moves
 *   unfinished auto-scheduled tasks to the next free slot.
 */
export type TaskSchedulingPreference = 'autoScheduleFlowTasks' | 'autoScheduleCrmTasks' | 'autoRescheduleTasks';

export function TaskSchedulingSwitch({ preference }: Readonly<{ preference: TaskSchedulingPreference }>) {
  const ts = getTranslations('settings').taskScheduling;
  const { data: preferences } = useUserPreferences();
  const updatePreferences = useUpdateUserPreferences();
  const queryClient = useQueryClient();
  const [checked, setChecked] = React.useState(true);

  React.useEffect(() => {
    if (!preferences) return;
    const ui = preferences.uiPreferences;
    const stored =
      preference === 'autoRescheduleTasks' ? ui?.[preference] : ui?.[preference] ?? ui?.autoScheduleTasks;
    setChecked(stored !== false);
  }, [preferences, preference]);

  const copy = {
    autoScheduleFlowTasks: { label: ts.autoScheduleLabel, description: ts.autoScheduleFlowDescription },
    autoScheduleCrmTasks: { label: ts.autoScheduleLabel, description: ts.autoScheduleCrmDescription },
    autoRescheduleTasks: { label: ts.autoRescheduleLabel, description: ts.autoRescheduleDescription },
  }[preference];

  const handleChange = async (next: boolean) => {
    setChecked(next);
    try {
      await updatePreferences.mutateAsync({ uiPreferences: { [preference]: next } });
      // Turning auto-scheduling off removes the task blocks it had placed.
      if (preference !== 'autoRescheduleTasks' && !next) {
        queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      }
    } catch {
      setChecked(!next);
      toast.error(ts.updateFailed);
    }
  };

  const id = `task-scheduling-${preference}`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id}>{copy.label}</Label>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={handleChange}
        disabled={!preferences || updatePreferences.isPending}
      />
    </div>
  );
}
