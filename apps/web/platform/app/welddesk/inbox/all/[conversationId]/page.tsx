
import React from 'react';
import { useParams, useRouter } from '@/lib/router';
import { useAuth, useUser } from '@clerk/clerk-react';
import ConversationDetailClient from './conversation-detail-client';
import { useConversation, useConversationMessages, useConversationReview } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ConversationPage() {
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;
  const { userId } = useAuth();
  const { user } = useUser();

  const { data: conversationResult, isLoading: convLoading } = useConversation(conversationId, !!conversationId);

  const { data: messagesResult, isLoading: msgLoading } = useConversationMessages(conversationId, !!conversationId);

  const { data: reviewResult, isLoading: reviewLoading } = useConversationReview(conversationId);

  const isLoading = convLoading || msgLoading || reviewLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!conversationResult?.success || !conversationResult?.data) {
    router.push('/welddesk/inbox/all');
    return null;
  }

  return (
    <ConversationDetailClient
      key={conversationId}
      conversation={conversationResult.data}
      initialMessages={messagesResult?.data || messagesResult?.messages || []}
      accessToken={undefined}
      review={reviewResult?.data || reviewResult?.review || undefined}
      userId={userId || undefined}
      userName={user?.fullName || user?.primaryEmailAddress?.emailAddress || ti.agentFallback}
      userAvatar={user?.imageUrl}
    />
  );
}
