import { useState, useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { GeneralSection } from './general-section';
import { LabelsSection } from './labels-section';
import { StagesSection } from './stages-section';
import { MembersClient } from '../members/members-client';
import { GithubSection } from './github-section';
import { ImportSection } from './import-section';
import { useI18n } from '@/lib/i18n/provider';

type SubTab = 'general' | 'members' | 'labels' | 'stages' | 'github' | 'import';

// Mirrors the (unexported) `ProjectMember`/`AvailableUser` shapes that
// `MembersClient` expects — kept local since `members`/`availableUsers` come
// through as untyped API rows from the project-members endpoints.
interface SettingsProjectMember {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  allocationPercentage?: number;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

interface SettingsAvailableUser {
  id: string;
  name: string;
  email: string;
  image?: string;
}

interface SettingsClientProps {
  projectId: string;
  members: SettingsProjectMember[];
  availableUsers: SettingsAvailableUser[];
  isAdmin: boolean;
  canWrite: boolean;
  isViewer: boolean;
}

function getInitialTab(): SubTab {
  if (typeof window === 'undefined') return 'general';
  const hash = window.location.hash.replace('#', '');
  if (hash === 'general' || hash === 'members' || hash === 'labels' || hash === 'stages' || hash === 'github' || hash === 'import') {
    return hash;
  }
  return 'general';
}

export function SettingsClient({
  projectId,
  members,
  availableUsers,
  isAdmin,
  canWrite,
  isViewer,
}: SettingsClientProps) {
  const { t } = useI18n();

  const tabs: { id: SubTab; label: string; description: string }[] = [
    { id: 'general', label: t.projects.settings.generalLabel, description: t.projects.settings.generalDesc },
    { id: 'members', label: t.projects.settings.membersLabel, description: t.projects.settings.membersDesc },
    { id: 'labels', label: t.projects.settings.labelsLabel, description: t.projects.settings.labelsDesc },
    { id: 'stages', label: t.projects.settings.stagesLabel, description: t.projects.settings.stagesDesc },
    { id: 'github', label: t.projects.settings.githubLabel, description: t.projects.settings.githubDesc },
    { id: 'import', label: t.projects.settings.importLabel, description: t.projects.settings.importDesc },
  ];

  useBreadcrumbs([
    { label: t.projects.settings.projects, href: '/weldflow' },
    { label: t.projects.settings.stagesLabel },
  ]);

  const [active, setActive] = useState<SubTab>(getInitialTab);

  useEffect(() => {
    const handler = () => setActive(getInitialTab());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const handleSelect = (id: SubTab) => {
    setActive(id);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${id}`);
    }
  };

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div className="flex justify-center flex-1 relative overflow-y-auto">
      <div className="w-full max-w-[1150px] flex relative">
        {/* Sidebar (matches /appstore) */}
        <div className="hidden md:flex md:w-60 md:shrink-0 pt-8 pb-6 md:pl-8 border-r border-border">
          <div className="sticky top-8 w-full">
            <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-4 uppercase">
              {t.projects.settings.settingsHeading}
            </h2>
            <div className="flex flex-col gap-1">
              {tabs.map((tab) => {
                const isActive = active === tab.id;
                return (
                  <Button
                    key={tab.id}
                    type="button"
                    variant="ghost"
                    onClick={() => handleSelect(tab.id)}
                    className={cn(
                      'py-2 px-3 text-left text-sm border-none rounded-lg cursor-pointer transition-all -ml-3 mr-3',
                      isActive
                        ? 'bg-accent text-foreground font-medium'
                        : 'text-muted-foreground font-normal hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {tab.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 md:p-6 md:pl-8 min-w-0">
          <div className="pb-8">
            <h2 className="text-lg font-semibold">{activeTab.label}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{activeTab.description}</p>
          </div>

          {active === 'general' && (
            <GeneralSection projectId={projectId} isAdmin={isAdmin} />
          )}
          {active === 'members' && (
            <MembersClient
              projectId={projectId}
              initialMembers={members}
              initialAvailableUsers={availableUsers}
              isAdmin={isAdmin}
              canWrite={canWrite}
              isViewer={isViewer}
            />
          )}
          {active === 'labels' && (
            <LabelsSection projectId={projectId} isAdmin={isAdmin} />
          )}
          {active === 'stages' && (
            <StagesSection projectId={projectId} isAdmin={isAdmin} />
          )}
          {active === 'github' && (
            <GithubSection projectId={projectId} isAdmin={isAdmin} />
          )}
          {active === 'import' && (
            <ImportSection projectId={projectId} canWrite={canWrite} />
          )}
        </div>
      </div>
    </div>
  );
}
