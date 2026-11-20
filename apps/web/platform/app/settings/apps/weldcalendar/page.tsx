import { getTranslations } from '@/lib/i18n';
import { TaskSchedulingSwitch } from '@/app/settings/apps/task-scheduling-switch';
import { OutsideEuNotice } from '@/components/outside-eu/outside-eu-notice';

export default function WeldCalendarSettingsPage() {
  const ts = getTranslations('settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.weldcalendar.title}</h1>
        <p className="text-muted-foreground">{ts.weldcalendar.description}</p>
      </div>
      {/* EU edition: Google Calendar sync sends events to Google, outside the EU (ADR OPS-026). */}
      <OutsideEuNotice services={['google_calendar']} />
      <TaskSchedulingSwitch preference="autoRescheduleTasks" />
    </div>
  );
}
