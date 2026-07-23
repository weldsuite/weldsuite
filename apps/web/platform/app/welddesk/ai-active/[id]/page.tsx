
import React from 'react';
import { useParams, useRouter } from '@/lib/router';
import ConversationDetailClient from '../../inbox/all/[conversationId]/conversation-detail-client';
import { useConversation, useConversationMessages } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

export default function AiActiveConversationPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: conversationResult, isLoading: convLoading } = useConversation(id);
  const { data: messagesResult, isLoading: msgLoading } = useConversationMessages(id);

  const isLoading = convLoading || msgLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!conversationResult?.success || !conversationResult?.data) {
    router.push('/welddesk/ai-active');
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
