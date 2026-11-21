/**
 * Unsubscribe rules shared by the Subscriptions page and the Unsubscribe
 * button in an open email. The unsubscribe itself runs server-side
 * (`POST /api/mail-subscriptions/:id/unsubscribe`, which picks one-click,
 * mailto or the sender's page); these helpers decide what the user is told
 * before and after. See docs/plans/weldmail-unsubscribe-in-message.md.
 */

import { toast } from 'sonner';
import type { MailSubscription, UnsubscribeResult } from '@weldsuite/app-api-client';
import { interpolate, type useI18n } from '@/lib/i18n/provider';

/** `t.mail.subscriptions`. */
export type SubscriptionLabels = ReturnType<typeof useI18n>['t']['mail']['subscriptions'];

type Sender = Pick<MailSubscription, 'senderName' | 'senderEmail'>;
type Targets = Pick<MailSubscription, 'unsubscribeUrl' | 'unsubscribeMailto' | 'oneClick'>;

export function senderLabel(sub: Sender): string {
  return sub.senderName || sub.senderEmail;
}

/** The sender offers some way to unsubscribe. */
export function canUnsubscribe(sub: Targets): boolean {
  return !!sub.unsubscribeUrl || !!sub.unsubscribeMailto;
}

/** Only a plain https link, so the browser has to open the sender's page. */
export function isLinkOnly(sub: Targets): boolean {
  return !!sub.unsubscribeUrl && !sub.oneClick && !sub.unsubscribeMailto;
}

/**
 * WeldMail can unsubscribe without the user leaving the app: an RFC 8058
 * one-click request or an unsubscribe email from the mailbox.
 */
export function unsubscribesInPlace(sub: Targets): boolean {
  return (sub.oneClick && !!sub.unsubscribeUrl) || !!sub.unsubscribeMailto;
}

/**
 * The mailbox's subscription for this sender address. A subscription is
 * identified by its lower-cased sender address, one row per mailbox.
 */
export function findSenderSubscription<T extends Pick<MailSubscription, 'senderEmail'>>(
  subscriptions: readonly T[] | undefined,
  senderEmail: string | null | undefined,
): T | undefined {
  const email = senderEmail?.trim().toLowerCase();
  if (!email || !subscriptions) return undefined;
  return subscriptions.find((s) => s.senderEmail.toLowerCase() === email);
}

/** What the confirm dialog says will happen. */
export function confirmDescriptionFor(labels: SubscriptionLabels, sub: Sender & Targets): string {
  let template = labels.confirmLink;
  if (sub.oneClick && sub.unsubscribeUrl) template = labels.confirmOneClick;
  else if (sub.unsubscribeMailto) template = labels.confirmMailto;
  return interpolate(template, { sender: senderLabel(sub) });
}

export interface UnsubscribeNotice {
  kind: 'success' | 'info';
  message: string;
  /** A page the user still has to open; the toast offers it as an action. */
  openUrl: string | null;
}

/** The toast after an unsubscribe, from how the server did it. */
export function unsubscribeNotice(
  labels: SubscriptionLabels,
  sub: Sender & Targets,
  result: Pick<UnsubscribeResult, 'method' | 'url'>,
): UnsubscribeNotice {
  const sender = senderLabel(sub);
  if (result.method === 'one_click') {
    return { kind: 'success', message: interpolate(labels.successOneClick, { sender }), openUrl: null };
  }
  if (result.method === 'mailto') {
    return { kind: 'success', message: interpolate(labels.successMailto, { sender }), openUrl: null };
  }
  // A link-only sender's page was already opened inside the click; otherwise
  // one-click failed with no mailto to fall back on, so offer the page.
  const openUrl = !isLinkOnly(sub) && result.url ? result.url : null;
  return { kind: 'info', message: interpolate(labels.successLink, { sender }), openUrl };
}

export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function notifyUnsubscribed(
  labels: SubscriptionLabels,
  sub: Sender & Targets,
  result: Pick<UnsubscribeResult, 'method' | 'url'>,
): void {
  const notice = unsubscribeNotice(labels, sub, result);
  if (notice.kind === 'success') {
    toast.success(notice.message);
    return;
  }
  const { openUrl } = notice;
  if (openUrl) {
    toast.info(notice.message, {
      action: { label: labels.openPage, onClick: () => openInNewTab(openUrl) },
      duration: 15_000,
    });
  } else {
    toast.info(notice.message);
  }
}
