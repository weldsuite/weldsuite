import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/link/page';

// `weldmail_` keeps this page out of the WeldMail layout: it is a bare
// interstitial in its own tab, not a mailbox screen.
export const Route = createFileRoute('/weldmail_/link')({ component: PageComponent });
