'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import type { PlanOption } from '@/lib/billing-types';
import type { AdminPartnerDetail } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { AppOption } from '@/components/partners/licence-fields';
import { ContractTab } from './contract-tab';
import { MembersTab } from './members-tab';
import { PaymentTab } from './payment-tab';
import { ProfileTab } from './profile-tab';
import { StatementsTab } from './statements-tab';
import { TerritoriesTab } from './territories-tab';
import { WorkspacesTab } from './workspaces-tab';

const TABS = ['profile', 'contract', 'territories', 'members', 'workspaces', 'statements', 'payment'] as const;
type TabKey = (typeof TABS)[number];

export interface PartnerTabProps {
  detail: AdminPartnerDetail;
  canWrite: boolean;
  planOptions: PlanOption[];
  appOptions: AppOption[];
  nowIso: string;
}

/** The seven tabs of a partner. The active one is kept in `?tab=` so a refresh or a shared link lands on it. */
export function PartnerDetail(props: Readonly<PartnerTabProps & { initialTab?: string }>) {
  const t = partnersCopy().detail.tabs;
  const [tab, setTab] = useState<TabKey>(() => (TABS as readonly string[]).includes(props.initialTab ?? '') ? (props.initialTab as TabKey) : 'profile');

  const onTab = (next: string) => {
    setTab(next as TabKey);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.replaceState(null, '', url);
    } catch {
      // The tab still switches; only the shareable URL is lost.
    }
  };

  return (
    <Tabs value={tab} onValueChange={onTab} className="gap-4">
      <TabsList className="h-auto flex-wrap justify-start">
        {TABS.map((key) => (
          <TabsTrigger key={key} value={key} className="flex-none px-3">
            {t[key]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="profile">
        <ProfileTab {...props} />
      </TabsContent>
      <TabsContent value="contract">
        <ContractTab {...props} />
      </TabsContent>
      <TabsContent value="territories">
        <TerritoriesTab {...props} />
      </TabsContent>
      <TabsContent value="members">
        <MembersTab {...props} />
      </TabsContent>
      <TabsContent value="workspaces">
        <WorkspacesTab {...props} />
      </TabsContent>
      <TabsContent value="statements">
        <StatementsTab {...props} />
      </TabsContent>
      <TabsContent value="payment">
        <PaymentTab {...props} />
      </TabsContent>
    </Tabs>
  );
}
