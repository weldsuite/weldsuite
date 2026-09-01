import { createFileRoute } from '@tanstack/react-router';
import PhoneSettingsPage from '@/app/welddesk/settings/phone/page';

export const Route = createFileRoute('/welddesk/settings/phone/')({
  component: PhoneSettingsRoute,
});

function PhoneSettingsRoute() {
  return <PhoneSettingsPage />;
}
