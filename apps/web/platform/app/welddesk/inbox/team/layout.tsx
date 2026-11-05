
import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import TeamListClient from './team-list-client';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { useIsDetailSelected } from '@/hooks/use-is-detail-selected';
import { useConversations, useDepartment } from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

interface TeamInboxLayoutProps {
  teamId: string;
  children: React.ReactNode;
}

export default function TeamInboxLayout({ teamId, children }: Readonly<TeamInboxLayoutProps>) {
  const { getToken } = useAuth();
  const [accessToken, setAccessToken] = useState<string>();

  const { data: conversationsResult } = useConversations({ page: 1, pageSize: 50, departmentId: teamId });
  const conversations: Helpdesk.Conversation[] = conversationsResult?.data || [];

  const { data: departmentResult } = useDepartment(teamId);
  const teamName = departmentResult?.data?.name || 'Team';

  React.useEffect(() => {
    getToken().then(token => {
      if (token) setAccessToken(token);
    });
  }, [getToken]);

  const isDetailSelected = useIsDetailSelected(`/welddesk/inbox/team/${teamId}`);

  return (
    <ListDetailLayout
      listWidth={420}
      isDetailSelected={isDetailSelected}
      list={
        <TeamListClient
          teamId={teamId}
          teamName={teamName}
          initialConversations={conversations}
          accessToken={accessToken}
        />
      }
    >
      {children}
    </ListDetailLayout>
  );
}
