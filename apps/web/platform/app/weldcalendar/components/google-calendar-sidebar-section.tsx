import { useState } from 'react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import { getTranslations } from '@/lib/i18n';

const GOOGLE_CALENDAR_COLOR = '#4285f4';

function getGoogleCalendarVisible(): boolean {
  try {
    return localStorage.getItem('weldcalendar:google-visible') !== 'false';
  } catch {
    return true;
  }
}

function setGoogleCalendarVisible(visible: boolean) {
  localStorage.setItem('weldcalendar:google-visible', String(visible));
  window.dispatchEvent(new CustomEvent('weldcalendar:visibility-changed'));
}

interface GoogleCalendarSidebarSectionProps {
  isConnected: boolean;
}

export function GoogleCalendarSidebarSection({ isConnected }: GoogleCalendarSidebarSectionProps) {
  const [visible, setVisible] = useState(getGoogleCalendarVisible);
  const t = getTranslations('weldcalendar');

  const toggleVisibility = () => {
    const next = !visible;
    setVisible(next);
    setGoogleCalendarVisible(next);
  };

  // Only surface the Google Calendar row once it's actually connected. The
  // connect flow lives in Settings → Integrations → Google Calendar, so we
  // don't show a "Connect" prompt in the calendar sidebar.
  if (!isConnected) {
    return null;
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="justify-between cursor-pointer"
          onClick={toggleVisibility}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Checkbox
              checked={visible}
              className="h-4 w-4 pointer-events-none"
              style={{
                borderColor: GOOGLE_CALENDAR_COLOR,
                backgroundColor: visible ? GOOGLE_CALENDAR_COLOR : undefined,
              }}
            />
            <span className="truncate text-sm">{t.googleCalendar.label}</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
