import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { WeldMeetHeader } from './weldmeet-header';
import { ModuleContent } from '@/components/layout/module-content';

// Eagerly preload the RealtimeKit SDK chunks so they're already in the
// browser cache by the time the user clicks "Start an instant meeting".
// Mirrors the pattern in apps/web/platform/app/weldchat/layout.tsx.
import('@cloudflare/realtimekit').catch(() => {});
import('@cloudflare/realtimekit-react').catch(() => {});

interface WeldMeetLayoutClientProps {
  children: ReactNode;
}

export function WeldMeetLayoutClient({ children }: WeldMeetLayoutClientProps) {
  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: 'WeldMeet', href: '/weldmeet' }]}>
      <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
        <WeldMeetHeader />
        <ModuleContent>{children}</ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
