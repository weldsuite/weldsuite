import { createFileRoute } from '@tanstack/react-router';
import AttioCallbackClient from '@/app/settings/integrations/attio/callback-client';

export const Route = createFileRoute('/settings/integrations/attio/callback')({
  component: AttioCallbackClient,
});
