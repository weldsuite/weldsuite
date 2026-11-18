/**
 * Delivery channels of alerts and scheduled reports, as a form edits them.
 * The Slack webhook URL is write-only: the API only says one is set, so the
 * form keeps it, replaces it or removes it, and sends the URL only when
 * replacing (`null` removes, absent keeps).
 */

import {
  isSlackWebhookUrl,
  PANEL_MAX_EMAIL_RECIPIENTS,
  type PanelDeliveryChannelsDto,
  type PanelDeliveryChannelsInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';

export type SlackMode = 'none' | 'keep' | 'set' | 'remove';

export interface ChannelsDraft {
  emailUserIds: string[];
  inApp: boolean;
  /** `none`: no webhook and none to add; `keep`: the stored one stays; `set`: replace with `url`; `remove`: drop the stored one. */
  slackMode: SlackMode;
  slackUrl: string;
  weldchatChannelId: string | null;
}

export function channelsDraft(dto?: PanelDeliveryChannelsDto | null): ChannelsDraft {
  return {
    emailUserIds: dto?.emailUserIds ?? [],
    inApp: dto?.inApp ?? false,
    slackMode: dto?.slack ? 'keep' : 'none',
    slackUrl: '',
    weldchatChannelId: dto?.weldchatChannelId ?? null,
  };
}

export type ChannelsProblem = 'slackInvalid' | 'tooManyEmails' | 'none';

/** What is wrong with the draft, or null. An empty Slack field in `set` counts as no Slack. */
export function channelsProblem(draft: ChannelsDraft): ChannelsProblem | null {
  const url = draft.slackUrl.trim();
  if (draft.slackMode === 'set' && url !== '' && !isSlackWebhookUrl(url)) return 'slackInvalid';
  if (draft.emailUserIds.length > PANEL_MAX_EMAIL_RECIPIENTS) return 'tooManyEmails';
  const slack = draft.slackMode === 'keep' || (draft.slackMode === 'set' && url !== '');
  if (draft.emailUserIds.length === 0 && !draft.inApp && !slack && !draft.weldchatChannelId) return 'none';
  return null;
}

/** The channels as the API takes them. */
export function channelsInput(draft: ChannelsDraft): PanelDeliveryChannelsInput {
  const out: PanelDeliveryChannelsInput = {
    emailUserIds: draft.emailUserIds,
    inApp: draft.inApp,
    weldchatChannelId: draft.weldchatChannelId,
  };
  const url = draft.slackUrl.trim();
  if (draft.slackMode === 'set' && url !== '') out.slackWebhookUrl = url;
  else if (draft.slackMode === 'remove') out.slackWebhookUrl = null;
  return out;
}

export type ChannelKey = 'email' | 'inApp' | 'slack' | 'weldchat';

/** Which channels a saved alert or schedule sends to, in a fixed order. */
export function activeChannels(dto: PanelDeliveryChannelsDto): { key: ChannelKey; count?: number }[] {
  const out: { key: ChannelKey; count?: number }[] = [];
  if (dto.emailUserIds.length > 0) out.push({ key: 'email', count: dto.emailUserIds.length });
  if (dto.inApp) out.push({ key: 'inApp' });
  if (dto.slack) out.push({ key: 'slack' });
  if (dto.weldchatChannelId) out.push({ key: 'weldchat' });
  return out;
}
