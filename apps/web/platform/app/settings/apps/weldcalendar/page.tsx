import { getTranslations } from '@/lib/i18n';
import { TaskSchedulingSwitch } from '@/app/settings/apps/task-scheduling-switch';

export default function WeldCalendarSettingsPage() {
  const ts = getTranslations('settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldcalendar.title}</h1>
        <p className="text-muted-foreground">{ts.weldcalendar.description}</p>
      </div>
      <TaskSchedulingSwitch preference="autoRescheduleTasks" />
    </div>
  );
}
