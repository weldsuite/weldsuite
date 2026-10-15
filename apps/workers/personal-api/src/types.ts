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
