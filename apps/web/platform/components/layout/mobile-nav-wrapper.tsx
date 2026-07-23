
import * as React from 'react';
import { MobileNavProvider } from '@/contexts/mobile-nav-context';
import { MobileHeader } from './mobile-header';
import { MobileSidebar } from './mobile-sidebar';
import { TextSelectionTooltip } from '@/components/text-selection-tooltip';
import { WeldAgentProvider } from '@/components/weldagent-wrapper';
import type { InstalledApp } from '@/lib/api/apps';

interface MobileNavWrapperProps {
  children: React.ReactNode;
  installedApps: InstalledApp[];
}

export function MobileNavWrapper({ children, installedApps }: MobileNavWrapperProps) {
  return (
    <MobileNavProvider>
      <WeldAgentProvider>
        <MobileHeader />
        <MobileSidebar installedApps={installedApps} />
        <TextSelectionTooltip />
        {children}
      </WeldAgentProvider>
    </MobileNavProvider>
  );
}
