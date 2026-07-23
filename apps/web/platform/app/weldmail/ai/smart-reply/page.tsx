
import { SmartReplyClient } from './smart-reply-client';
import { useMailAccounts, useMailMessages } from '@/hooks/queries/use-mail-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function SmartReplyPage() {
  const { t } = useI18n();
  const { data: accountsData, isLoading: accountsLoading } = useMailAccounts();
  const accounts = accountsData?.data ?? [];
  const defaultAccount = accounts[0];

  // Load INBOX messages for the default (first) account via the app-api hook.
  // Limit 20 matches the legacy page size; the hook maps limit and drops the
  // old page param automatically.
  const { data: messagesData, isLoading: messagesLoading } = useMailMessages(
    defaultAccount?.id ?? '',
    { label: 'INBOX', limit: 20 },
    !accountsLoading && !!defaultAccount?.id,
  );

  if (accountsLoading || messagesLoading) return <PageLoader fullScreen={false} />;

  const rawMessages: Record<string, unknown>[] =
    (messagesData?.data as Record<string, unknown>[] | undefined) ?? [];

  const relevantMessages = rawMessages
    .filter((m) => !m.isRead || m.isImportant)
    .slice(0, 5);

  let emails = relevantMessages.map((msg) => ({
    id: msg.id as string,
    from:
      ((msg.from as Record<string, unknown> | undefined)?.email as string | undefined) ??
      t.mail.shared.unknown,
    subject: (msg.subject as string | undefined) ?? t.mail.shared.noSubject,
    preview: (
      (msg.textBody as string | undefined) ??
      (msg.htmlBody as string | undefined)?.replace(/<[^>]*>/g, '') ??
      (msg.preview as string | undefined) ??
      ''
    ).substring(0, 200),
    date: (msg.receivedDate ?? msg.createdAt) as Date,
  }));

  if (emails.length === 0) {
    emails = [
      {
        id: 'sample-1',
        from: t.mail.ai.noEmailsFound,
        subject: t.mail.ai.connectEmailAccount,
        preview: t.mail.ai.smartReplyWillAnalyze,
        date: new Date(),
      },
    ];
  }

  const suggestedReplies = [
    {
      tone: t.mail.ai.professional,
      text: t.mail.ai.selectEmailToGenerateReply,
      confidence: 0,
      intent: t.mail.ai.waiting,
    },
    {
      tone: t.mail.ai.friendly,
      text: t.mail.ai.selectEmailToGenerateReply,
      confidence: 0,
      intent: t.mail.ai.waiting,
    },
    {
      tone: t.mail.ai.brief,
      text: t.mail.ai.selectEmailToGenerateReply,
      confidence: 0,
      intent: t.mail.ai.waiting,
    },
  ];

  const stats = {
    repliesSent: 0,
    timeSaved: '0 hours',
    responseRate: '0%',
    accuracy: '0%',
  };

  return (
    <SmartReplyClient
      emails={emails}
      suggestedReplies={suggestedReplies}
      stats={stats}
    />
  );
}
