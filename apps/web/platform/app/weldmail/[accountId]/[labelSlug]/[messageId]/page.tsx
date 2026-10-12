
import { useParams, useRouter } from '@/lib/router';
import { useEffect } from 'react';
import { MailMessageView } from '../../../components/mail-message-view';
import { PageLoader } from '@/components/page-loader';

export default function LabelMessagePage() {
  const params = useParams();
  const router = useRouter();
  const accountId = params.accountId as string;
  const labelSlug = decodeURIComponent(params.labelSlug as string);
  const messageId = params.messageId as string;

  const isDraft = messageId.startsWith('draft_') || messageId.startsWith('draft-');

  // Redirect drafts to compose page
  useEffect(() => {
    if (messageId.startsWith('draft_')) {
      router.replace(`/weldmail/${accountId}/${labelSlug}/compose?draftId=${messageId}`);
    }
  }, [messageId, accountId, labelSlug, router]);

  if (isDraft) {
    return <PageLoader fullScreen={false} />;
  }

  return <MailMessageView accountId={accountId} labelSlug={labelSlug} messageId={messageId} />;
}
