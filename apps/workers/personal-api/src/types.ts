import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';
import type { PersonalEntitlements } from './lib/billing';

/** Cloudflare Workers send_email binding (EmailMessage form). */
export interface SendEmailBinding {
  send(message: { readonly from: string; readonly to: string }): Promise<void>;
}

/**
 * The outbound mail guard's bindings (`OUTBOUND_LEDGER`, `OUTBOUND_PLATFORM`,
 * `OUTBOUND_BACKSTOP`): Durable Objects hosted by mail-api, bound by name, all
 * optional because the guard fails open. docs/plans/weldmail-outbound-abuse.md.
 */
export interface Env extends Pick<OutboundGuardEnv, 'OUTBOUND_LEDGER' | 'OUTBOUND_PLATFORM' | 'OUTBOUND_BACKSTOP'> {
  /** Neon connection string for master DB (personal_accounts, registry). */
  DATABASE_URL_MASTER: string;
  /** Neon connection string for shared personal DB (mail + calendar tables). */
  DATABASE_URL_PERSONAL: string;
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY?: string;
  ENVIRONMENT: string;
  /** Cloudflare Email Sending binding — required for outbound mail. */
  SEND_EMAIL?: SendEmailBinding;
  /**
   * The storage bucket the inbound worker writes personal attachments to
   * (`personal/<personalAccountId>/…`). Read only behind the owner check.
   */
  STORAGE?: R2Bucket;
  /** This worker's public origin; inline-image URLs point at its `/public/mail-inline`. */
  PERSONAL_API_PUBLIC_URL?: string;
  /** Secret inline-image tokens are sealed with. Unset: inline images keep `cid:` and do not show. */
  MAIL_INLINE_IMAGE_SECRET?: string;
}

export type PersonalAccountSummary = {
  id: string;
  clerkUserId: string;
  displayName: string | null;
};

export type Variables = {
  userId: string;
  sessionId: string;
  personalAccountId: string | null;
  personalAccount: PersonalAccountSummary | null;
  entitlements: PersonalEntitlements;
};
