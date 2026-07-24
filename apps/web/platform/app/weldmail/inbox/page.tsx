
import { useMailAccounts, useMailMessages } from '@/hooks/queries/use-mail-queries';
import { InboxClient } from './inbox-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import type { Mail as MailTypes } from '@/lib/api/types/apps/mail.types';

export default function InboxPage() {
  const { t } = useI18n();
  const { data: accountsData, isLoading: accountsLoading } = useMailAccounts();
  const accounts = accountsData?.data || [];
  const activeAccount = accounts.find((a) => a.isDefault) || accounts[0];

  const { data: messagesData, isLoading: messagesLoading } = useMailMessages(
    activeAccount?.id,
    { page: 1, pageSize: 50, label: 'INBOX' },
    !!activeAccount,
  );

  if (accountsLoading || messagesLoading) return <PageLoader fullScreen={false} />;

  if (!activeAccount) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">{t.mail.accounts.noEmailAccount}</h2>
          <p className="text-muted-foreground">
            {t.mail.accounts.noEmailAccountDescription}
          </p>
        </div>
      </div>
    );
  }

  const messages = messagesData?.data || [];

  // Transform the real messages to the format expected by InboxClient. When
  // the account genuinely has no INBOX mail we pass an empty list — never
  // fabricated sample data — so the UI reflects the true server state.
  const transformedMessages = messages.map((msg) => {
    const fromData = msg.from;
    const fromName = fromData?.name || fromData?.email?.split('@')[0] || '';
    const fromEmail = fromData?.email || '';

    const toEmails = (msg.to || []).map((t) => t.email);
    const ccEmails = (msg.cc || []).map((c) => c.email);
    const bccEmails = (msg.bcc || []).map((b) => b.email);

    return {
      id: msg.id,
      messageId: msg.messageId,
      subject: msg.subject || '(No Subject)',
      from: fromName || fromEmail,
      fromEmail: fromEmail,
      to: toEmails,
      cc: ccEmails,
      bcc: bccEmails,
      bodyText: msg.textBody || '',
      bodyHtml: msg.htmlBody || '',
      preview: msg.preview || msg.textBody?.substring(0, 200) || '',
      date: msg.sentDate || msg.receivedDate || new Date(),
      isRead: msg.isRead ?? false,
      isStarred: msg.isStarred ?? false,
      isImportant: msg.isImportant ?? false,
      isDraft: msg.isDraft ?? false,
      isSpam: msg.labels?.includes('spam') ?? false,
      isDeleted: msg.labels?.includes('trash') ?? false,
      hasAttachments: msg.hasAttachments ?? false,
      size: msg.sizeBytes || 0,
      labels: msg.labels || [],
      folder: 'Inbox',
    };
  });

  return (
    <InboxClient
      initialMessages={transformedMessages as unknown as MailTypes.Email[]}
      folders={[]}
      currentFolder={{ id: 'inbox', name: 'Inbox', type: 'system' }}
      activeAccount={{
        id: activeAccount.id,
        email: activeAccount.email,
        displayName: activeAccount.displayName || activeAccount.name || activeAccount.email,
      }}
    />
  );
}
