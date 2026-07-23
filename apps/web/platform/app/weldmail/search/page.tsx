
import { SearchClient } from './search-client';
import { useMailAccounts, useMailMessages } from '@/hooks/queries/use-mail-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function SearchPage() {
  const { t } = useI18n();
  const { data: accountsData, isLoading: accountsLoading } = useMailAccounts();
  const accounts = accountsData?.data || [];
  const activeAccount = accounts.find((a: any) => a.isDefault) || accounts[0];

  const { data: messagesData, isLoading: messagesLoading } = useMailMessages(
    activeAccount?.id,
    { page: 1, pageSize: 100, label: 'INBOX' },
    !!activeAccount,
  );

  if (accountsLoading || messagesLoading) return <PageLoader fullScreen={false} />;

  const messages = messagesData?.data || [];
  const emails = messages.map((email: any) => {
    const fromEmail = typeof email.from === 'object' ? email.from?.email : email.from;
    const fromName = typeof email.from === 'object' ? email.from?.name : email.fromName;

    return {
      id: email.id,
      from: fromName || fromEmail || t.mail.shared.unknown,
      fromEmail: fromEmail,
      subject: email.subject || t.mail.shared.noSubject,
      preview: email.preview || '',
      date: new Date(email.receivedDate || email.sentDate || email.createdAt),
      isRead: email.isRead ?? false,
      isStarred: email.isStarred ?? false,
      hasAttachments: email.hasAttachments ?? false,
      labels: email.labels || [],
    };
  });

  return <SearchClient initialEmails={emails} />;
}
