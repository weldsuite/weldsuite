import { createFileRoute } from '@tanstack/react-router';
import GoogleCalendarCallbackClient from '@/app/settings/integrations/google-calendar/callback-client';

export const Route = createFileRoute('/settings/integrations/google-calendar/callback')({
  component: GoogleCalendarCallbackClient,
});
