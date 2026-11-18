import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/alerts/page';

/** `?alert=<id>` opens that alert (the link alert emails and notifications carry). */
export const Route = createFileRoute('/weldpanel/alerts/')({
  validateSearch: (raw: Record<string, unknown>): { alert?: string } => (typeof raw.alert === 'string' && raw.alert !== '' ? { alert: raw.alert } : {}),
  component: PageComponent,
});
