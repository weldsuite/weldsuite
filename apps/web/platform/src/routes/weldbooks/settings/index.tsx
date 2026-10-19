import { createFileRoute } from '@tanstack/react-router';
import { WeldbooksSettingsRedirect } from '@/app/weldbooks/settings/redirects';

// The WeldBooks settings moved to the WeldBooks tab of the entity in Settings → Entities.
export const Route = createFileRoute('/weldbooks/settings/')({
  component: WeldbooksSettingsRedirect,
});
