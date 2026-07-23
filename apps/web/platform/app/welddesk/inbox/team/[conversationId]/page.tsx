
import React from 'react';
import { useParams, useRouter } from '@/lib/router';
import ConversationDetailClient from '../../all/[conversationId]/conversation-detail-client';
import { useConversation, useConversationMessages } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

export default function TeamConversationPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;
  const teamId = params.teamId as string;

  const { data: conversationResult, isLoading: convLoading } = useConversation(conversationId);
  const { data: messagesResult, isLoading: msgLoading } = useConversationMessages(conversationId);

  const isLoading = convLoading || msgLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!conversationResult?.success || !conversationResult?.data) {
    router.push(`/welddesk/inbox/team/${teamId}`);
    return null;
  }

  return (
    <ConversationDetailClient
      conversation={conversationResult.data}
      initialMessages={messagesResult?.data || []}
      accessToken={undefined}
    />
  );
}
