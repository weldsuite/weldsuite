import React from 'react';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import type { BadgeProps } from '@weldsuite/mobile-ui/components/Badge';
import type { DeskChannel, DeskConversationState } from '@/types/desk';
import { useI18n } from '@/lib/i18n';

type Variant = NonNullable<BadgeProps['variant']>;

const STATE_VARIANTS: Record<DeskConversationState, Variant> = {
  open: 'default',
  closed: 'secondary',
};

export function ConversationStateBadge({
  state,
  size = 'sm',
}: {
  state: DeskConversationState;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  const label = state === 'open' ? t.inbox.open : t.inbox.closed;
  return (
    <Badge variant={STATE_VARIANTS[state]} size={size}>
      {label}
    </Badge>
  );
}

export function ChannelBadge({
  channel,
  size = 'sm',
}: {
  channel: DeskChannel;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  const labels: Record<DeskChannel, string> = {
    messenger: t.channel.messenger,
    email: t.channel.email,
    phone: t.channel.phone,
    whatsapp: t.channel.whatsapp,
    sms: t.channel.sms,
    api: t.channel.api,
  };
  return (
    <Badge variant="outline" size={size}>
      {labels[channel] ?? channel}
    </Badge>
  );
}
