import * as React from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@weldsuite/ui/components/sheet';
import { useMemberProfile } from '@/hooks/queries/use-team-queries';
import { TeamMemberPanelHeader } from './header';
import { OverviewTab } from './tabs/overview-tab';
import { NotesTab } from './tabs/notes-tab';
import { CommonTab } from './tabs/common-tab';

export type TeamMemberPanelTab = 'overview' | 'notes' | 'common';

interface TeamMemberPanelProps {
  userId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: TeamMemberPanelTab;
}

export function TeamMemberPanel({
  userId,
  open,
  onOpenChange,
  defaultTab = 'overview',
}: TeamMemberPanelProps) {
  const t = useTranslations();
  const { userId: viewerUserId } = useAuth();
  const profileQuery = useMemberProfile(userId ?? undefined);
  const [tab, setTab] = React.useState<TeamMemberPanelTab>(defaultTab);

  // Reset tab when switching member
  React.useEffect(() => {
    setTab(defaultTab);
  }, [userId, defaultTab]);

  const isSelf = !!userId && !!viewerUserId && userId === viewerUserId;
  const profile = profileQuery.data;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[540px] max-w-full p-0 flex flex-col sm:max-w-[540px]">
        <SheetHeader className="sr-only">
          <SheetTitle>{t('sweep.shared.teamMemberDetails')}</SheetTitle>
          <SheetDescription>{t('sweep.shared.teamMemberDetailsDescription')}</SheetDescription>
        </SheetHeader>

        {!userId || profileQuery.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">{t('sweep.shared.loadingEllipsis')}</div>
        ) : !profile ? (
          <div className="p-6 text-sm text-muted-foreground">{t('sweep.shared.memberNotFound')}</div>
        ) : (
          <>
            <TeamMemberPanelHeader
              profile={profile}
              onClose={() => onOpenChange(false)}
              isSelf={isSelf}
            />

            <div className="flex border-b text-sm">
              <TabButton active={tab === 'overview'} onClick={() => setTab('overview')}>
                {t('sweep.shared.overview')}
              </TabButton>
              <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>
                {t('sweep.shared.notes')}
              </TabButton>
              {!isSelf && (
                <TabButton active={tab === 'common'} onClick={() => setTab('common')}>
                  {t('sweep.shared.common')}
                </TabButton>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {tab === 'overview' && <OverviewTab profile={profile} />}
              {tab === 'notes' && <NotesTab userId={profile.userId} />}
              {tab === 'common' && <CommonTab userId={profile.userId} isSelf={isSelf} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={
        'flex-1 px-4 py-2.5 font-medium transition-colors border-b-2 -mb-px ' +
        (active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </Button>
  );
}
