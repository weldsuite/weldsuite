/**
 * The Filter button above the conversation list: WeldMail's filter panel, with
 * the reply inbox's own fields (state, label, campaign, mailbox). Changes apply
 * when the panel's Apply button is pressed, as in WeldMail.
 */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { FilterButton } from '@weldsuite/ui/components/filter-button';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Separator } from '@weldsuite/ui/components/separator';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachReplyLabel } from '@weldsuite/app-api-client/schemas/reach';
import { useReachCampaigns } from '@/hooks/queries/use-reach-campaign-queries';
import { useReachMailboxes } from '@/hooks/queries/use-reach-queries';
import { REPLY_LABEL_ORDER, replyLabelKey } from '@/app/weldreach/components/engage/badges';
import { INBOX_STATES, type InboxState } from '../lib/thread-state';

export interface InboxFilterValue {
  state: InboxState;
  label?: ReachReplyLabel;
  campaignId?: string;
  mailboxId?: string;
}

/** The inbox opens on the conversations still to handle. */
export const DEFAULT_INBOX_FILTER: InboxFilterValue = { state: 'open' };

const STATE_KEYS: Record<InboxState, string> = {
  open: 'reachEngage.inbox.states.open',
  unread: 'reachEngage.inbox.states.unread',
  handled: 'reachEngage.inbox.states.handled',
  all: 'reachEngage.inbox.states.all',
};

/** How many filters differ from the default, for the count on the Filter button. */
export function countActiveFilters(filter: InboxFilterValue): number {
  return [
    filter.state !== DEFAULT_INBOX_FILTER.state,
    filter.label !== undefined,
    filter.campaignId !== undefined,
    filter.mailboxId !== undefined,
  ].filter(Boolean).length;
}

const ROW_CLASS = 'grid grid-cols-[96px_1fr] items-center gap-3';
const LABEL_CLASS = 'text-sm text-muted-foreground';

export function InboxFilter({
  value,
  onChange,
}: Readonly<{ value: InboxFilterValue; onChange: (value: InboxFilterValue) => void }>) {
  const t = useTranslations();
  const campaigns = useReachCampaigns();
  const mailboxes = useReachMailboxes();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InboxFilterValue>(value);

  const activeCount = countActiveFilters(value);
  const draftCount = countActiveFilters(draft);
  const update = (changes: Partial<InboxFilterValue>) => setDraft((previous) => ({ ...previous, ...changes }));

  function apply() {
    onChange(draft);
    setOpen(false);
  }

  function clear() {
    setDraft(DEFAULT_INBOX_FILTER);
    onChange(DEFAULT_INBOX_FILTER);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // The panel always opens on what is applied, not on an abandoned draft.
        if (next) setDraft(value);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <FilterButton count={activeCount}>{t('reachEngage.inbox.filter')}</FilterButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-4">
        <div className="space-y-3">
          <div className={ROW_CLASS}>
            <span id="reach-inbox-filter-state" className={LABEL_CLASS}>
              {t('reachEngage.inbox.filterState')}
            </span>
            <Select value={draft.state} onValueChange={(next) => update({ state: next as InboxState })}>
              <SelectTrigger aria-labelledby="reach-inbox-filter-state" className="h-8 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INBOX_STATES.map((state) => (
                  <SelectItem key={state} value={state}>
                    {t(STATE_KEYS[state])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={ROW_CLASS}>
            <span className={LABEL_CLASS}>{t('reachEngage.inbox.filterLabel')}</span>
            <FilterSelect
              value={draft.label}
              onChange={(next) => update({ label: next as ReachReplyLabel | undefined })}
              options={REPLY_LABEL_ORDER.map((label) => ({ value: label, label: t(replyLabelKey(label)) }))}
              allLabel={t('reachEngage.inbox.allLabels')}
              ariaLabel={t('reachEngage.inbox.labelFilter')}
              className="w-full"
            />
          </div>

          <div className={ROW_CLASS}>
            <span className={LABEL_CLASS}>{t('reachEngage.inbox.filterCampaign')}</span>
            <FilterSelect
              value={draft.campaignId}
              onChange={(next) => update({ campaignId: next })}
              options={campaigns.campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))}
              allLabel={t('reachEngage.inbox.allCampaigns')}
              ariaLabel={t('reachEngage.inbox.campaignFilter')}
              className="w-full"
            />
          </div>

          <div className={ROW_CLASS}>
            <span className={LABEL_CLASS}>{t('reachEngage.inbox.filterMailbox')}</span>
            <FilterSelect
              value={draft.mailboxId}
              onChange={(next) => update({ mailboxId: next })}
              options={(mailboxes.data ?? []).map((mailbox) => ({ value: mailbox.id, label: mailbox.email }))}
              allLabel={t('reachEngage.inbox.allMailboxes')}
              ariaLabel={t('reachEngage.inbox.mailboxFilter')}
              className="w-full"
            />
          </div>
        </div>

        <Separator className="my-5" />

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-sm text-muted-foreground"
            disabled={draftCount === 0 && activeCount === 0}
            onClick={clear}
          >
            {t('reachEngage.inbox.clearFilters')}
          </Button>
          <Button size="sm" className="h-8 text-sm" onClick={apply}>
            {t('reachEngage.inbox.applyFilters')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
