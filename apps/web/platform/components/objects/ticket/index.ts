import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const TicketPanel = lazy(() =>
  import('./ticket-panel').then((m) => ({ default: m.TicketPanel })),
);

registerObjectPanel({
  type: 'ticket',
  label: 'Ticket',
  component: TicketPanel,
});

export { TicketPanel };
