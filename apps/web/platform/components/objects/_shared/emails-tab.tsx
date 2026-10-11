/**
 * `EmailsTab` — Emails tab for the company object panel.
 *
 * Lists `mail_messages` rows where the company's primary email appears as
 * sender or any recipient (to/cc/bcc). Backed by a new
 * `counterpartyEmail` filter on the `/api/mail-messages` list endpoint
 * which does JSONB containment matching across the four address fields.
 *
 * If the company has no email on record the tab renders an empty state
 * pointing the user at the Details tab to fill it in. The message list itself
 * renders through `EntityList` (search + top bar) for parity with the other
 * object-panel tabs.
 */

import { useCallback, useMemo } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { Mail, MailOpen, Paperclip, Plus, Star } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { applySelectFilters } from '@/lib/list-filters';
import { EmailsIllustration, TabEmptyState, TAB_EMPTY_STATE_TABLE_CLASS } from './tab-empty-state';
import { TabListRow, TabListScope } from './tab-list-row';
import { useMailMessagesByCounterparty } from '@/hooks/queries/use-mail-queries';
import { useComposeSafe } from '@/contexts/compose-context';

interface EmailsTabProps {
  /** Counterparty primary email — used to filter mail messages. */
  entityEmail?: string;
  entityKind: 'company' | 'person';
}

interface MessageRow {
  id: string;
  subject?: string;
  snippet?: string;
  from?: { email?: string; name?: string };
  isRead?: boolean;
  isStarred?: boolean;
  hasAttachments?: boolean;
  receivedAt?: string;
  createdAt: string;
}

const COLUMN = {
  from: 'w-[220px] @max-[560px]:w-[130px]',
  subject: 'min-w-0 flex-1',
  date: 'w-[90px]',
};

// Search-friendly row: lifts the nested sender name to the top level so
// EntityList's `searchFields` (which reads `keyof T`) can match on it.
type EmailListItem = MessageRow & { senderName: string };

function applyEmailFilters(items: EmailListItem[], filters: ActiveFilter[]): EmailListItem[] {
  return applySelectFilters(items, filters, {
    read: (m, value) => (m.isRead ? 'read' : 'unread') === value,
    starred: (m, value) => (m.isStarred ? 'yes' : 'no') === value,
    attachments: (m, value) => (m.hasAttachments ? 'yes' : 'no') === value,
  });
}

function formatMailDate(d: Date, yesterdayLabel: string): string {
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return yesterdayLabel;
  return format(d, 'MMM d');
}

export function EmailsTab({ entityEmail, entityKind }: Readonly<EmailsTabProps>) {
  const t = useTranslations();
  const compose = useComposeSafe();
  const trimmed = entityEmail?.trim();
  const { data, isLoading } = useMailMessagesByCounterparty(trimmed);

  const handleCompose = useCallback(() => {
    if (!trimmed) return;
    if (compose) {
      compose.openCompose({ to: trimmed });
      return;
    }
    window.location.href = `mailto:${trimmed}`;
  }, [compose, trimmed]);

  const messages = useMemo<EmailListItem[]>(() => {
    const rows = (data?.data ?? []) as MessageRow[];
    return [...rows]
      .sort((a, b) => {
        const aTime = a.receivedAt ?? a.createdAt;
        const bTime = b.receivedAt ?? b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      })
      .map((m) => ({
        ...m,
        senderName: m.from?.name ?? m.from?.email ?? t('sweep.entities.unknownSender'),
      }));
  }, [data, t]);

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
    const when = m.receivedAt ? new Date(m.receivedAt) : new Date(m.createdAt);
    const Icon = m.isRead ? MailOpen : Mail;
    return (
      <TabListRow key={m.id} label={m.subject || t('sweep.entities.noSubject')}>
        <div className={cn(COLUMN.from, 'flex items-center gap-2')}>
          <Icon className={cn('h-4 w-4 flex-shrink-0', m.isRead ? 'text-muted-foreground' : 'text-blue-600')} />
          <span className={cn('truncate text-sm', m.isRead ? 'text-foreground/80' : 'font-medium text-foreground')}>
            {m.senderName}
          </span>
        </div>
        <div className={cn(COLUMN.subject, 'flex items-baseline gap-2')}>
          <span className={cn('truncate text-sm', m.isRead ? 'text-muted-foreground' : 'text-foreground')}>
            {m.subject || t('sweep.entities.noSubject')}
          </span>
          {m.snippet ? (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{m.snippet}</span>
          ) : null}
          {m.isStarred ? (
            <Star className="h-3 w-3 flex-shrink-0 self-center fill-yellow-400 text-yellow-400" />
          ) : null}
          {m.hasAttachments ? (
            <Paperclip className="h-3 w-3 flex-shrink-0 self-center text-muted-foreground" />
          ) : null}
        </div>
        <div className={COLUMN.date}>
          <span className="text-sm text-muted-foreground">
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
        searchFields={['senderName', 'subject', 'snippet']}
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
