/** Status, validation and reply-label badges shared by the engage pages. */

import { Sparkles } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useTranslations } from '@weldsuite/i18n/client';
import type {
  ReachCampaignStatus,
  ReachEnrollmentStatus,
  ReachInboundKind,
  ReachMailboxStatus,
  ReachProspectValidation,
  ReachReplyLabel,
} from '@weldsuite/app-api-client/schemas/reach';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

// Keys are spelled out (not built from the value) so a missing translation
// shows up in a text search and the maps stay exhaustive over the contract enums.

const CAMPAIGN_STATUS: Record<ReachCampaignStatus, { key: string; variant: BadgeVariant }> = {
  draft: { key: 'reachEngage.status.campaign.draft', variant: 'secondary' },
  active: { key: 'reachEngage.status.campaign.active', variant: 'success' },
  paused: { key: 'reachEngage.status.campaign.paused', variant: 'warning' },
  completed: { key: 'reachEngage.status.campaign.completed', variant: 'default' },
  archived: { key: 'reachEngage.status.campaign.archived', variant: 'outline' },
};

export function campaignStatusKey(status: ReachCampaignStatus): string {
  return CAMPAIGN_STATUS[status].key;
}

export function CampaignStatusBadge({ status }: Readonly<{ status: ReachCampaignStatus }>) {
  const t = useTranslations();
  const { key, variant } = CAMPAIGN_STATUS[status];
  return <Badge variant={variant}>{t(key)}</Badge>;
}

const ENROLLMENT_STATUS: Record<ReachEnrollmentStatus, { key: string; variant: BadgeVariant }> = {
  queued: { key: 'reachEngage.status.enrollment.queued', variant: 'secondary' },
  active: { key: 'reachEngage.status.enrollment.active', variant: 'success' },
  replied: { key: 'reachEngage.status.enrollment.replied', variant: 'default' },
  bounced: { key: 'reachEngage.status.enrollment.bounced', variant: 'destructive' },
  unsubscribed: { key: 'reachEngage.status.enrollment.unsubscribed', variant: 'warning' },
  completed: { key: 'reachEngage.status.enrollment.completed', variant: 'outline' },
  paused: { key: 'reachEngage.status.enrollment.paused', variant: 'warning' },
  failed: { key: 'reachEngage.status.enrollment.failed', variant: 'destructive' },
};

export function enrollmentStatusKey(status: ReachEnrollmentStatus): string {
  return ENROLLMENT_STATUS[status].key;
}

export function EnrollmentStatusBadge({ status }: Readonly<{ status: ReachEnrollmentStatus }>) {
  const t = useTranslations();
  const { key, variant } = ENROLLMENT_STATUS[status];
  return <Badge variant={variant}>{t(key)}</Badge>;
}

const MAILBOX_STATUS: Record<ReachMailboxStatus, { key: string; variant: BadgeVariant }> = {
  provisioning: { key: 'reachEngage.status.mailbox.provisioning', variant: 'secondary' },
  warming: { key: 'reachEngage.status.mailbox.warming', variant: 'warning' },
  active: { key: 'reachEngage.status.mailbox.active', variant: 'success' },
  paused: { key: 'reachEngage.status.mailbox.paused', variant: 'secondary' },
  suspended: { key: 'reachEngage.status.mailbox.suspended', variant: 'destructive' },
  error: { key: 'reachEngage.status.mailbox.error', variant: 'destructive' },
  deleting: { key: 'reachEngage.status.mailbox.deleting', variant: 'outline' },
  deleted: { key: 'reachEngage.status.mailbox.deleted', variant: 'outline' },
};

export function mailboxStatusKey(status: ReachMailboxStatus): string {
  return MAILBOX_STATUS[status].key;
}

export function MailboxStatusBadge({ status }: Readonly<{ status: ReachMailboxStatus }>) {
  const t = useTranslations();
  const { key, variant } = MAILBOX_STATUS[status];
  return <Badge variant={variant}>{t(key)}</Badge>;
}

const VALIDATION: Record<
  ReachProspectValidation,
  { label: string; hint: string; variant: BadgeVariant }
> = {
  valid: {
    label: 'reachEngage.validation.valid.label',
    hint: 'reachEngage.validation.valid.hint',
    variant: 'success',
  },
  role: {
    label: 'reachEngage.validation.role.label',
    hint: 'reachEngage.validation.role.hint',
    variant: 'warning',
  },
  consumer: {
    label: 'reachEngage.validation.consumer.label',
    hint: 'reachEngage.validation.consumer.hint',
    variant: 'warning',
  },
  no_mx: {
    label: 'reachEngage.validation.no_mx.label',
    hint: 'reachEngage.validation.no_mx.hint',
    variant: 'destructive',
  },
  invalid: {
    label: 'reachEngage.validation.invalid.label',
    hint: 'reachEngage.validation.invalid.hint',
    variant: 'destructive',
  },
  suppressed: {
    label: 'reachEngage.validation.suppressed.label',
    hint: 'reachEngage.validation.suppressed.hint',
    variant: 'secondary',
  },
};

/** Translation keys for a validation value: its name and what it means for sending. */
export function validationKeys(validation: ReachProspectValidation): { label: string; hint: string } {
  return VALIDATION[validation];
}

/** The prospect's validation result, with what it means for sending on hover. */
export function ValidationBadge({ validation }: Readonly<{ validation: ReachProspectValidation }>) {
  const t = useTranslations();
  const { label, hint, variant } = VALIDATION[validation];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className="cursor-default">
          {t(label)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t(hint)}</TooltipContent>
    </Tooltip>
  );
}

const REPLY_LABEL: Record<ReachReplyLabel, { key: string; variant: BadgeVariant }> = {
  interested: { key: 'reachEngage.labels.interested', variant: 'success' },
  meeting_request: { key: 'reachEngage.labels.meeting_request', variant: 'success' },
  not_interested: { key: 'reachEngage.labels.not_interested', variant: 'destructive' },
  not_now: { key: 'reachEngage.labels.not_now', variant: 'warning' },
  out_of_office: { key: 'reachEngage.labels.out_of_office', variant: 'secondary' },
  wrong_person: { key: 'reachEngage.labels.wrong_person', variant: 'outline' },
  unsubscribe: { key: 'reachEngage.labels.unsubscribe', variant: 'destructive' },
  other: { key: 'reachEngage.labels.other', variant: 'outline' },
  unclassified: { key: 'reachEngage.labels.unclassified', variant: 'outline' },
};

/** Label names in the order the pickers list them. */
export const REPLY_LABEL_ORDER: ReachReplyLabel[] = [
  'interested',
  'meeting_request',
  'not_interested',
  'not_now',
  'out_of_office',
  'wrong_person',
  'unsubscribe',
  'other',
  'unclassified',
];

export function replyLabelKey(label: ReachReplyLabel): string {
  return REPLY_LABEL[label].key;
}

/** The reply's label; a sparkle marks one the AI chose. */
export function ReplyLabelBadge({
  label,
  source,
}: Readonly<{ label: ReachReplyLabel; source?: 'ai' | 'user' | 'rule' | null }>) {
  const t = useTranslations();
  const { key, variant } = REPLY_LABEL[label];
  return (
    <Badge variant={variant}>
      {source === 'ai' && (
        <Sparkles aria-label={t('reachEngage.labels.aiLabelled')} className="h-3 w-3" />
      )}
      {t(key)}
    </Badge>
  );
}

const INBOUND_KIND: Record<ReachInboundKind, { key: string; variant: BadgeVariant }> = {
  reply: { key: 'reachEngage.kinds.reply', variant: 'outline' },
  auto_reply: { key: 'reachEngage.kinds.auto_reply', variant: 'secondary' },
  bounce: { key: 'reachEngage.kinds.bounce', variant: 'destructive' },
};

/** Marks a bounce or an automatic reply; a plain reply needs no badge. */
export function InboundKindBadge({ kind }: Readonly<{ kind: ReachInboundKind | null }>) {
  const t = useTranslations();
  if (!kind || kind === 'reply') return null;
  const { key, variant } = INBOUND_KIND[kind];
  return <Badge variant={variant}>{t(key)}</Badge>;
}
