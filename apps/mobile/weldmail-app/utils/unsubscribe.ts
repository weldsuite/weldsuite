/**
 * Unsubscribe rules shared by the Subscriptions screen and the Unsubscribe
 * button on an open email. The server does the unsubscribing (one-click
 * request, unsubscribe email, or the sender's page handed back); these decide
 * what the user is told. See docs/plans/weldmail-unsubscribe-in-message.md.
 */

import type { SubscriptionMethod, TenantSubscription } from '@/services/mail-tenant';

type Sender = Pick<TenantSubscription, 'senderName' | 'senderEmail'>;
type Targets = Pick<TenantSubscription, 'unsubscribeUrl' | 'unsubscribeMailto' | 'oneClick'>;

export function senderLabel(sub: Sender): string {
  return sub.senderName || sub.senderEmail;
}

/** The sender offers some way to unsubscribe. */
export function canUnsubscribe(sub: Targets): boolean {
  return !!sub.unsubscribeUrl || !!sub.unsubscribeMailto;
}

/** A mailbox's subscription for this sender address (lower-cased, one per mailbox). */
export function findSenderSubscription<T extends Pick<TenantSubscription, 'senderEmail'>>(
  subscriptions: readonly T[] | undefined,
  senderEmail: string | null | undefined,
): T | undefined {
  const email = senderEmail?.trim().toLowerCase();
  if (!email || !subscriptions) return undefined;
  return subscriptions.find((s) => s.senderEmail.toLowerCase() === email);
}

/** What the confirm dialog says will happen. */
export function unsubscribeConfirmMessage(sub: Sender & Targets): string {
  const sender = senderLabel(sub);
  if (sub.oneClick && sub.unsubscribeUrl) return `WeldMail will ask ${sender} to stop sending email to this mailbox.`;
  if (sub.unsubscribeMailto) return `WeldMail will send an unsubscribe request from this mailbox to ${sender}.`;
  return `The unsubscribe page of ${sender} opens in your browser. Finish the steps there.`;
}

export interface UnsubscribeOutcome {
  kind: 'success' | 'info';
  message: string;
  /** The sender's page, still to be opened to finish. */
  openUrl: string | null;
}

/** The toast after an unsubscribe, from how the server did it. */
export function unsubscribeOutcome(method: SubscriptionMethod, url: string | null, sender: string): UnsubscribeOutcome {
  if (method === 'one_click') return { kind: 'success', message: `Unsubscribed from ${sender}`, openUrl: null };
  if (method === 'mailto') return { kind: 'success', message: `Unsubscribe request sent to ${sender}`, openUrl: null };
  return { kind: 'info', message: `Finish unsubscribing on the page of ${sender}`, openUrl: url };
}
