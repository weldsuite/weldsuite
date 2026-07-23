import { Calendar } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function ProjectCalendarPage() {
  const { t } = useI18n();
  return (
    <div className="border rounded-lg p-12 text-center">
      <Calendar className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
      <h3 className="text-lg font-medium mb-2">{t.projects.calendar.calendarView}</h3>
      <p className="text-muted-foreground">{t.projects.calendar.calendarDescription}</p>
    </div>
  );
}
