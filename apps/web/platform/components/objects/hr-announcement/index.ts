import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';
import { HR_ANNOUNCEMENT_PANEL_TYPE } from './types';

// Lazy-loaded so the panel body only ships when one is opened (the object-panel
// host wraps the renderer in <Suspense>).
const HrAnnouncementPanel = lazy(() => import('./hr-announcement-panel').then((m) => ({ default: m.HrAnnouncementPanel })));

registerObjectPanel({ type: HR_ANNOUNCEMENT_PANEL_TYPE, label: 'Announcement', component: HrAnnouncementPanel });
