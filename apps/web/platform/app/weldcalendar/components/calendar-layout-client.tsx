
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { CalendarHeader } from './calendar-header';
import { ModuleContent } from '@/components/layout/module-content';

interface CalendarLayoutClientProps {
  children: ReactNode;
}

/**
 * Portal target for the calendar event detail panel. `display: contents` so
 * the portaled panel becomes a real flex sibling of the content card inside
 * ModuleContent's row — same layout slot ObjectPanelHost / DrawerHost use.
 */
function CalendarEventPanelSlot() {
  return <div id="weldcalendar-event-panel-slot" className="contents" />;
}

export function CalendarLayoutClient({ children }: CalendarLayoutClientProps) {
  return (
    <div className="flex-1 flex flex-col w-full min-h-0 overflow-hidden">
      <CalendarHeader />
      <ModuleContent aside={<CalendarEventPanelSlot />}>
        <BreadcrumbProvider>{children}</BreadcrumbProvider>
      </ModuleContent>
    </div>
  );
}
