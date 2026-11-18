import { Settings2, Users } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { getTranslations } from '@/lib/i18n';
import { SocialGeneralSettings } from './general-section';
import { SocialTeamSettings } from './team-section';

const TABS = ['general', 'team'] as const;
type SettingsTab = (typeof TABS)[number];

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

/** Settings → Apps → WeldSocial: publishing defaults and the WeldSocial team. */
export default function WeldSocialSettingsPage() {
  const ts = getTranslations('settings');
  const search = useSearch({ from: '/settings/apps/social' });
  const navigate = useNavigate();
  const activeTab: SettingsTab = isSettingsTab(search.tab) ? search.tab : 'general';

  const tabs: PageTab[] = [
    { id: 'general', label: ts.social.tabs.general, icon: Settings2 },
    { id: 'team', label: ts.social.tabs.team, icon: Users },
  ];

  return (
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.social.title}</h1>
        <p className="text-muted-foreground">{ts.social.description}</p>
      </div>
      <PageTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(tab) => navigate({ to: '/settings/apps/social', search: tab === 'general' ? {} : { tab } })}
      />
      <div className="mt-6">
        {activeTab === 'general' && <SocialGeneralSettings />}
        {activeTab === 'team' && <SocialTeamSettings />}
      </div>
    </div>
  );
}
