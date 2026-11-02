
import * as React from 'react';
import { MobileNavProvider } from '@/contexts/mobile-nav-context';
import { MobileHeader } from './mobile-header';
import { MobileSidebar } from './mobile-sidebar';
import { TextSelectionTooltip } from '@/components/text-selection-tooltip';
import { WeldAgentProvider } from '@/components/weldagent-wrapper';
import type { InstalledApp } from '@/lib/api/apps';
import { isModuleOffered } from '@/lib/edition';

interface MobileNavWrapperProps {
  children: React.ReactNode;
  installedApps: InstalledApp[];
}

export function MobileNavWrapper({ children, installedApps }: Readonly<MobileNavWrapperProps>) {
  return (
    <MobileNavProvider>
      <WeldAgentProvider>
        <MobileHeader />
        <MobileSidebar installedApps={installedApps} />
        {/* "Ask WeldAgent" on selected text: edition flags (4.F3), needs the agent module. */}
        {isModuleOffered('agent') && <TextSelectionTooltip />}
        {children}
      </WeldAgentProvider>
    </MobileNavProvider>
  );
}
