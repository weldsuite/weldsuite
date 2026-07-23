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
import { EntityList } from '@/components/entity-list';
import { useMailMessagesByCounterparty } from '@/hooks/queries/use-mail-queries';

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

// Search-friendly row: lifts the nested sender name to the top level so
// EntityList's `searchFields` (which reads `keyof T`) can match on it.
type EmailListItem = MessageRow & { senderName: string };

function formatMailDate(d: Date, yesterdayLabel: string): string {
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return yesterdayLabel;
  return format(d, 'MMM d');
}

export function EmailsTab({ entityEmail, entityKind }: EmailsTabProps) {
  const t = useTranslations();
  const trimmed = entityEmail?.trim();
  const { data, isLoading } = useMailMessagesByCounterparty(trimmed);

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

  const renderRow = useCallback((m: EmailListItem) => {
    const when = m.receivedAt ? new Date(m.receivedAt) : new Date(m.createdAt);
    const Icon = m.isRead ? MailOpen : Mail;
    return (
      <div key={m.id} className="group/row px-2 py-0.5">
        <div className="flex items-start gap-2 hover:bg-muted/50 rounded-md px-2 py-2 transition-colors">
          <Icon
            className={cn(
              'h-4 w-4 mt-0.5 flex-shrink-0',
              m.isRead ? 'text-muted-foreground' : 'text-blue-600',
            )}
          />
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  'text-sm truncate flex-1',
                  m.isRead ? 'text-foreground/80' : 'text-foreground font-medium',
                )}
              >
                {m.senderName}
              </span>
              {m.isStarred ? (
                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400 flex-shrink-0" />
              ) : null}
              {m.hasAttachments ? (
                <Paperclip className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              ) : null}
              <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
                {formatMailDate(when, t('sweep.entities.yesterday'))}
              </span>
            </div>
            <span
              className={cn(
                'text-xs truncate',
                m.isRead ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {m.subject || t('sweep.entities.noSubject')}
            </span>
            {m.snippet ? (
              <span className="text-xs text-muted-foreground truncate">{m.snippet}</span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }, [t]);

  if (!trimmed) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-6 py-12 gap-2">
        <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
          <Mail className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="text-sm font-medium text-foreground">{t('sweep.entities.noEmailOnFile')}</div>
        <p className="text-xs text-muted-foreground max-w-[42ch]">
          {entityKind === 'company'
            ? t('sweep.entities.noEmailOnFileDescriptionCompany')
            : t('sweep.entities.noEmailOnFileDescriptionPerson')}
        </p>
      </div>
    );
  }

  return (
    <EntityList<EmailListItem>
      items={messages}
      isLoading={isLoading}
      error={null}
      filters={[]}
      renderRow={renderRow}
      searchPlaceholder={t('sweep.entities.searchEmailsPlaceholder')}
      searchFields={['senderName', 'subject', 'snippet']}
      itemsClassName="py-1.5"
      actionButtons={
        <Button
          size="sm"
          className="h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() => (window.location.href = `mailto:${encodeURIComponent(trimmed)}`)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sweep.entities.compose')}
        </Button>
      }
      emptyState={{
        icon: (
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center mb-3">
            <Mail className="h-5 w-5 text-muted-foreground" />
          </div>
        ),
        title: t('sweep.entities.noEmailsYetTitle'),
        description: t('sweep.entities.noEmailsYetDescription', { email: trimmed }),
      }}
      noResultsState={{
        title: t('sweep.entities.noEmailsFoundTitle'),
        description: t('sweep.entities.noEmailsFoundDescription'),
      }}
    />
  );
}
