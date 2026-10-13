/**
 * Test doubles for the Mailpool client and billing. Used only by tests
 * (`*.test.ts`); never imported by worker code.
 */

import { vi } from 'vitest';
import type { ReachBilling } from '../billing';
import type { MailpoolClient } from './client';
import type { CreateMailpoolMailboxInput, MailpoolMailbox } from './types';

export type FakeMailpool = { [K in keyof MailpoolClient]: ReturnType<typeof vi.fn> & MailpoolClient[K] };

let mailboxSeq = 9000;

/** A mailbox as Mailpool returns it right after creation: active, with SMTP and IMAP logins. */
export function mailpoolMailbox(input: CreateMailpoolMailboxInput, overrides: Partial<MailpoolMailbox> = {}): MailpoolMailbox {
  mailboxSeq += 1;
  return {
    id: String(mailboxSeq),
    type: input.type,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    signature: input.signature ?? '',
    forwardTo: input.forwardTo,
    status: 'active',
    smtpHost: 'smtp.mailpool.test',
    smtpPort: input.type === 'google' ? 465 : '587',
    smtpTLS: true,
    smtpUsername: input.email,
    smtpPassword: 'smtp-secret-password',
    imapHost: 'imap.mailpool.test',
    imapPort: 993,
    imapTLS: true,
    imapUsername: input.email,
    imapPassword: 'imap-secret-password',
    ...overrides,
  };
}

/**
 * A Mailpool client whose every method is a `vi.fn` with a sensible default
 * (an account with free google slots). Override per test.
 */
export function createFakeMailpool(overrides: Partial<Record<keyof MailpoolClient, unknown>> = {}): FakeMailpool {
  const fake = {
    getDomain: vi.fn(async (id: string | number) => ({ id, domain: 'example.test', status: 'active' as const })),
    deleteDomain: vi.fn(async (id: string | number) => ({ id, domain: 'example.test', status: 'inactive' as const })),
    getDomainDns: vi.fn(async () => []),
    updateDomainDns: vi.fn(async () => []),
    setDmarcPolicy: vi.fn(async (id: string | number) => ({ id, domain: 'example.test', status: 'active' as const })),
    setDmarcEmail: vi.fn(async (id: string | number) => ({ id, domain: 'example.test', status: 'active' as const })),
    listCloudflareZones: vi.fn(async () => []),
    connectCloudflareDomains: vi.fn(async (domains: string[]) => ({
      connected: domains.map((domain, i) => ({ id: 5000 + i, domain, status: 'Active', dnsType: 'CloudflareToken' })),
      skipped: [],
    })),
    createMailbox: vi.fn(async (input: CreateMailpoolMailboxInput) => mailpoolMailbox(input)),
    listMailboxes: vi.fn(async () => ({ data: [], total: 0 })),
    getMailbox: vi.fn(async (id: string | number) => ({
      id,
      type: 'google' as const,
      email: 'x@example.test',
      status: 'active' as const,
    })),
    updateMailbox: vi.fn(async (id: string | number) => ({
      id,
      type: 'google' as const,
      email: 'x@example.test',
      status: 'active' as const,
    })),
    deleteMailbox: vi.fn(async (id: string | number) => ({
      id,
      type: 'google' as const,
      email: 'x@example.test',
      status: 'inactive' as const,
    })),
    cancelMailboxDeletion: vi.fn(async (id: string | number) => ({
      id,
      type: 'google' as const,
      email: 'x@example.test',
      status: 'active' as const,
    })),
    getSlots: vi.fn(async () => ({ mailboxes: { google: 0, private: 0, outlook: 0 }, slots: { google: 50, private: 0, outlook: 0 } })),
    increaseSlots: vi.fn(async () => undefined),
    decreaseSlots: vi.fn(async () => undefined),
  };
  return { ...fake, ...overrides } as unknown as FakeMailpool;
}

export type FakeBilling = { [K in keyof ReachBilling]: ReturnType<typeof vi.fn> & ReachBilling[K] };

export function createFakeBilling(overrides: Partial<Record<keyof ReachBilling, unknown>> = {}): FakeBilling {
  const fake = {
    status: vi.fn(async () => ({
      status: 'active' as const,
      hasPaymentMethod: true,
      inboxCount: 1,
      unitAmountCents: 500,
      currency: 'usd',
      currentPeriodEnd: null,
    })),
    setup: vi.fn(async () => ({ url: 'https://checkout.stripe.test/session' })),
    adjustInboxes: vi.fn(async (delta: 1 | -1) => ({ quantity: delta === 1 ? 1 : 0 })),
  };
  return { ...fake, ...overrides } as unknown as FakeBilling;
}
