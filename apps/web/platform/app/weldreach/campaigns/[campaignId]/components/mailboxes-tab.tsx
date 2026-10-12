/**
 * The Mailboxes tab: which of the workspace's mailboxes rotate in this
 * campaign. Only active mailboxes send; a mailbox that is still warming up
 * joins in as soon as its warmup is done.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  WELDREACH_SENDING_DEFAULTS,
  type ReachCampaignDetail,
  type ReachMailbox,
} from '@weldsuite/app-api-client/schemas/reach';
import { useSetReachCampaignMailboxes } from '@/hooks/queries/use-reach-campaign-queries';
import { useReachMailboxes } from '@/hooks/queries/use-reach-queries';
import { Link } from '@/lib/router';
import { MailboxStatusBadge } from '@/app/weldreach/components/engage/badges';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  EmptyText,
  ErrorBanner,
  InlineSpinner,
  Notice,
  SectionCard,
  TabBody,
  errorMessage,
} from '@/app/weldreach/components/engage/kit';

function sameSet(a: Set<string>, b: string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id));
}

/** What the row says about a mailbox besides its name: warmup progress, today's volume, or why it is not sending. */
function useMailboxNote() {
  const t = useTranslations();
  const format = useReachFormat();

  return (mailbox: ReachMailbox): string | null => {
    if (mailbox.status === 'warming') {
      return t('reachEngage.mailboxes.warmingNote', {
        day: mailbox.warmupDay,
        days: WELDREACH_SENDING_DEFAULTS.warmupDays,
      });
    }
    if (mailbox.status === 'active') {
      return t('reachEngage.mailboxes.sentToday', {
        sent: format.number(mailbox.sentToday),
        cap: format.number(mailbox.dailyCap),
      });
    }
    if (mailbox.status === 'paused' || mailbox.status === 'suspended' || mailbox.status === 'error') {
      return mailbox.pausedReason ?? mailbox.lastError ?? t('reachEngage.mailboxes.notSending');
    }
    return null;
  };
}

function MailboxListBody({
  isLoading,
  failed,
  error,
  rows,
  selected,
  readOnly,
  onToggle,
}: Readonly<{
  isLoading: boolean;
  failed: boolean;
  error: unknown;
  rows: ReachMailbox[];
  selected: Set<string>;
  readOnly: boolean;
  onToggle: (id: string) => void;
}>) {
  const t = useTranslations();
  const note = useMailboxNote();

  if (isLoading) return <InlineSpinner />;
  if (failed) return <ErrorBanner error={errorMessage(error, t('reachEngage.mailboxes.loadFailed'))} />;
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Mail className="h-8 w-8 text-muted-foreground/60" strokeWidth={1.5} />
        <EmptyText>{t('reachEngage.mailboxes.empty')}</EmptyText>
        <Button asChild variant="outline" size="sm">
          <Link href="/weldreach/mailboxes">{t('reachEngage.mailboxes.manage')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {rows.map((mailbox) => (
        <li key={mailbox.id}>
          <label
            className={
              readOnly
                ? 'flex items-center gap-3 px-3 py-3 opacity-80'
                : 'flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-muted/40'
            }
          >
            <Checkbox
              checked={selected.has(mailbox.id)}
              disabled={readOnly}
              onCheckedChange={() => onToggle(mailbox.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{mailbox.email}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[`${mailbox.firstName} ${mailbox.lastName}`.trim(), note(mailbox)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <MailboxStatusBadge status={mailbox.status} />
          </label>
        </li>
      ))}
    </ul>
  );
}

export function MailboxesTab({
  campaign,
  canEdit,
}: Readonly<{ campaign: ReachCampaignDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const mailboxes = useReachMailboxes();
  const save = useSetReachCampaignMailboxes(campaign.id);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(campaign.mailboxIds));
  const [failure, setFailure] = useState<string | null>(null);

  // The server's selection replaces local edits when it changes (after a save, or a change elsewhere).
  const serverKey = campaign.mailboxIds.join(',');
  useEffect(() => {
    setSelected(new Set(campaign.mailboxIds));
    // `serverKey` stands in for `campaign.mailboxIds`, whose identity changes on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const rows = useMemo(
    () =>
      (mailboxes.data ?? []).filter(
        (mailbox) => mailbox.status !== 'deleted' && mailbox.status !== 'deleting',
      ),
    [mailboxes.data],
  );
  const dirty = !sameSet(selected, campaign.mailboxIds);
  const canSend = rows.some((mailbox) => selected.has(mailbox.id) && mailbox.status === 'active');
  const readOnly = !canEdit;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setFailure(null);
    try {
      await save.mutateAsync([...selected]);
      toast.success(t('reachEngage.mailboxes.saved'));
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.mailboxes.saveFailed')));
    }
  }

  return (
    <TabBody>
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      {selected.size > 0 && !canSend && !mailboxes.isLoading && (
        <Notice tone="warning" title={t('reachEngage.mailboxes.noActiveTitle')}>
          {t('reachEngage.mailboxes.noActiveHint')}
        </Notice>
      )}

      <SectionCard
        title={t('reachEngage.mailboxes.title')}
        description={t('reachEngage.mailboxes.description')}
      >
        <MailboxListBody
          isLoading={mailboxes.isLoading}
          failed={mailboxes.isError}
          error={mailboxes.error}
          rows={rows}
          selected={selected}
          readOnly={readOnly}
          onToggle={toggle}
        />

        {rows.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {t('reachEngage.mailboxes.selectedCount', { count: selected.size })}
            </p>
            {canEdit && (
              <div className="flex items-center gap-2">
                {dirty && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={save.isPending}
                    onClick={() => setSelected(new Set(campaign.mailboxIds))}
                  >
                    {t('reachEngage.common.discard')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={!dirty || save.isPending}
                  onClick={() => void submit()}
                >
                  {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('reachEngage.common.save')}
                </Button>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </TabBody>
  );
}
