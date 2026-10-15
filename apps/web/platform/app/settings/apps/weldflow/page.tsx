import { getTranslations } from '@/lib/i18n';
import { TaskSchedulingSwitch } from '@/app/settings/apps/task-scheduling-switch';

export default function WeldFlowSettingsPage() {
  const ts = getTranslations('settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldflow.title}</h1>
        <p className="text-muted-foreground">{ts.weldflow.description}</p>
      </div>
      <TaskSchedulingSwitch preference="autoScheduleFlowTasks" />
    </div>
  );
}
