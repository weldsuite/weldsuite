import { createFileRoute } from '@tanstack/react-router';
import HubSpotCallbackClient from '@/app/settings/integrations/hubspot/callback-client';

export const Route = createFileRoute('/settings/integrations/hubspot/callback')({
  component: HubSpotCallbackClient,
});
