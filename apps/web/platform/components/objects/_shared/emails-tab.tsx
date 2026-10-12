/**
 * `EmailsTab` — Emails tab for the company object panel.
 *
 * Lists the `mail_messages` rows that mention the record's primary email: the
 * address goes to the `/api/mail-messages` list endpoint as its `search` term,
 * which matches the sender and recipients (and the subject and body).
 *
 * If the company has no email on record the tab renders an empty state
 * pointing the user at the Details tab to fill it in. The message list itself
 * renders through `EntityList` (search + top bar) for parity with the other
 * object-panel tabs. Clicking a row swaps the list for the message inside the
 * tab, shown with WeldMail's own view (`MailMessageView`); its back arrow
 * returns to the list.
 */

import { useCallback, useMemo, useState } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { Paperclip, Plus, Star } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { MailMessageRow } from '@weldsuite/app-api-client/domains/mail-messages';
import { cn } from '@/lib/utils';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { applySelectFilters } from '@/lib/list-filters';
import { EmailsIllustration, TabEmptyState, TAB_EMPTY_STATE_TABLE_CLASS } from './tab-empty-state';
import { TabListRow, TabListScope } from './tab-list-row';
import { useMailMessagesByCounterparty } from '@/hooks/queries/use-mail-queries';
import { useRowsWithCompanyLogos } from '@/lib/crm/company-logo';
import { useComposeSafe } from '@/contexts/compose-context';
import { MailMessageView } from '@/app/weldmail/components/mail-message-view';
import { resolveSenderAvatar, useMemberPictures } from './email-sender-avatar';

interface EmailsTabProps {
  /** Counterparty primary email — used to filter mail messages. */
  entityEmail?: string;
  entityKind: 'company' | 'person';
  /** The record's own image (uploaded avatar or company logo), shown on its messages. */
  entityAvatar?: string;
}

const COLUMN = {
  from: 'w-[220px] @max-[560px]:w-[130px]',
  subject: 'min-w-0 flex-1',
  date: 'w-[90px]',
};

// Search-friendly row: lifts the nested sender name to the top level so
// EntityList's `searchFields` (which reads `keyof T`) can match on it.
type EmailListItem = MailMessageRow & {
  senderName: string;
  /** The sender's own image: contact photo, the record's avatar, or a member's picture. */
  avatarUrl?: string;
  /** Workspace members keep their initial when they have no picture, not their company's logo. */
  isMember: boolean;
  /** Added by `useRowsWithCompanyLogos` when the sender's domain has a logo. */
  logoUrl?: string;
};

/**
 * WeldMail's message view fills its parent and scrolls inside it, so the tab
 * gives it a height: what is left of the window under the panel's header and
 * tab bar.
 */
const EMAIL_VIEW_HEIGHT_CLASS = 'h-[calc(100dvh-170px)] min-h-[320px]';

function senderLogoDomain(m: EmailListItem): string | undefined {
  if (m.avatarUrl || m.isMember) return undefined;
  return m.from?.email;
}

function applyEmailFilters(items: EmailListItem[], filters: ActiveFilter[]): EmailListItem[] {
  return applySelectFilters(items, filters, {
    read: (m, value) => (m.isRead ? 'read' : 'unread') === value,
    starred: (m, value) => (m.isStarred ? 'yes' : 'no') === value,
    attachments: (m, value) => (m.hasAttachments ? 'yes' : 'no') === value,
  });
}

/** When the mail arrived (or left); the row's own timestamp is only when it was synced. */
function messageDate(m: MailMessageRow): string {
  return m.receivedDate ?? m.sentDate ?? m.createdAt;
}

function formatMailDate(d: Date, yesterdayLabel: string): string {
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return yesterdayLabel;
  return format(d, 'MMM d');
}

export function EmailsTab({ entityEmail, entityKind, entityAvatar }: Readonly<EmailsTabProps>) {
  const t = useTranslations();
  const compose = useComposeSafe();
  const trimmed = entityEmail?.trim();
  const { data, isLoading } = useMailMessagesByCounterparty(trimmed);
  const memberPictures = useMemberPictures();
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);

  const handleCompose = useCallback(() => {
    if (!trimmed) return;
    if (compose) {
      compose.openCompose({ to: trimmed });
      return;
    }
    window.location.href = `mailto:${trimmed}`;
  }, [compose, trimmed]);

  const sortedMessages = useMemo<EmailListItem[]>(() => {
    const rows = data?.data ?? [];
    const record = { email: trimmed, kind: entityKind, avatar: entityAvatar };
    return [...rows]
      .sort((a, b) => new Date(messageDate(b)).getTime() - new Date(messageDate(a)).getTime())
      .map((m) => ({
        ...m,
        senderName: m.from?.name ?? m.from?.email ?? t('sweep.entities.unknownSender'),
        ...resolveSenderAvatar(m.from, record, memberPictures),
      }));
  }, [data, t, trimmed, entityKind, entityAvatar, memberPictures]);

  const messages = useRowsWithCompanyLogos(sortedMessages, senderLogoDomain);

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      {
        field: 'read',
        label: t('sweep.entities.fieldStatus'),
        options: [
          { value: 'unread', label: t('sweep.entities.filterUnread') },
          { value: 'read', label: t('sweep.entities.filterRead') },
        ],
      },
      {
        field: 'starred',
        label: t('sweep.entities.filterStarred'),
        options: [
          { value: 'yes', label: t('sweep.entities.filterStarred') },
          { value: 'no', label: t('sweep.entities.filterNotStarred') },
        ],
      },
      {
        field: 'attachments',
        label: t('sweep.entities.filterAttachments'),
        options: [
          { value: 'yes', label: t('sweep.entities.filterWithAttachments') },
          { value: 'no', label: t('sweep.entities.filterWithoutAttachments') },
        ],
      },
    ],
    [t],
  );

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'from', header: t('sweep.entities.fieldFrom'), width: COLUMN.from },
      { id: 'subject', header: t('sweep.entities.fieldSubject'), width: COLUMN.subject },
      { id: 'date', header: t('sweep.entities.fieldDate'), width: COLUMN.date },
    ],
    [t],
  );

  const renderRow = useCallback((m: EmailListItem) => {
    const when = new Date(messageDate(m));
    const avatarUrl = m.avatarUrl ?? m.logoUrl;
    return (
      <TabListRow key={m.id} label={m.subject || t('sweep.entities.noSubject')} onOpen={() => setOpenMessageId(m.id)}>
        <div className={cn(COLUMN.from, 'flex items-center gap-2')}>
          <Avatar className="h-[18px] w-[18px] !rounded-[6px] flex-shrink-0">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={m.senderName} className="!rounded-[6px] object-cover" />}
            <AvatarFallback className="!rounded-[6px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
              {(m.senderName.trim()[0] ?? '?').toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className={cn('truncate text-sm', m.isRead ? 'text-foreground/80' : 'font-medium text-foreground')}>
            {m.senderName}
          </span>
        </div>
        <div className={cn(COLUMN.subject, 'flex items-baseline gap-2')}>
          <span className={cn('truncate text-sm', m.isRead ? 'text-muted-foreground' : 'text-foreground')}>
            {m.subject || t('sweep.entities.noSubject')}
          </span>
          {m.preview ? (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{m.preview}</span>
          ) : null}
          {m.isStarred ? (
            <Star className="h-3 w-3 flex-shrink-0 self-center fill-yellow-400 text-yellow-400" />
          ) : null}
          {m.hasAttachments ? (
            <Paperclip className="h-3 w-3 flex-shrink-0 self-center text-muted-foreground" />
          ) : null}
        </div>
        <div className={COLUMN.date}>
          <span className="text-sm font-mono text-muted-foreground">
            {formatMailDate(when, t('sweep.entities.yesterday'))}
          </span>
        </div>
      </TabListRow>
    );
  }, [t]);

  if (!trimmed) {
    return (
      <TabEmptyState
        illustration={<EmailsIllustration />}
        bare
        title={t('sweep.entities.noEmailOnFile')}
        description={
          entityKind === 'company'
            ? t('sweep.entities.noEmailOnFileDescriptionCompany')
            : t('sweep.entities.noEmailOnFileDescriptionPerson')
        }
      />
    );
  }

  const openMessage = openMessageId ? messages.find((m) => m.id === openMessageId) : undefined;
  if (openMessage) {
    return (
      <div className={EMAIL_VIEW_HEIGHT_CLASS}>
        <MailMessageView
          accountId={openMessage.accountId}
          labelSlug={openMessage.labels?.includes('SENT') ? 'sent' : 'inbox'}
          messageId={openMessage.id}
          onClose={() => setOpenMessageId(null)}
        />
      </div>
    );
  }

  return (
    <TabListScope>
      <EntityList<EmailListItem>
        items={messages}
        isLoading={isLoading}
        error={null}
        filters={filterConfigs}
        applyFilters={applyEmailFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={t('sweep.entities.searchEmailsPlaceholder')}
        searchFields={['senderName', 'subject', 'preview']}
        actionButtons={
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={handleCompose}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('sweep.entities.compose')}
          </Button>
        }
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <EmailsIllustration />,
          title: t('sweep.entities.noEmailsYetTitle'),
          description: t('sweep.entities.noEmailsYetDescription', { email: trimmed }),
          action: {
            label: t('sweep.entities.compose'),
            onClick: handleCompose,
          },
        }}
        noResultsState={{
          title: t('sweep.entities.noEmailsFoundTitle'),
          description: t('sweep.entities.noEmailsFoundDescription'),
        }}
      />
    </TabListScope>
  );
}
