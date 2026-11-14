// The console's Mollie card on a Kubernetes edition, rendered to markup (the
// admin tests run in node): the rows, the past-due notice and the CLI hints.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MollieBillingAccount, WorkspaceBilling } from './billing-types';

vi.mock('@/app/workspaces/[id]/billing/subscription-card', () => ({
  Notice: ({ children }: { children: ReactNode }) => createElement('div', { 'data-notice': '' }, children),
}));

import { MollieBillingCard } from '@/app/workspaces/[id]/billing/mollie-billing-card';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';

const en = mollieBillingCopyByLocale.en;

const account: MollieBillingAccount = {
  customerId: 'cst_billing1',
  mandateId: 'mdt_billing1',
  mandateMethod: 'creditcard',
  mandateLabel: 'Visa •••• 4242',
  unitAmount: 4900,
  currency: 'EUR',
  anchorDay: 14,
  nextChargeAt: '2026-12-14T10:00:00.000Z',
  scheduled: { planId: 'plan_team', planName: 'Team', seats: 3, cycle: 'yearly' },
  pastDue: null,
};

const billing = { subscriptionCycle: 'monthly', currentPeriodEnd: '2026-12-14T10:00:00.000Z' } as WorkspaceBilling;

function card(over: Partial<MollieBillingAccount> = {}): string {
  return renderToStaticMarkup(
    createElement(MollieBillingCard, { workspaceId: 'ws_1', account: { ...account, ...over }, billing }),
  );
}

describe('MollieBillingCard', () => {
  it('shows the customer, the mandate, the price, the anchor and what is scheduled', () => {
    const html = card();
    expect(html).toContain('cst_billing1');
    expect(html).toContain('Visa •••• 4242');
    expect(html).toContain('mdt_billing1');
    expect(html).toContain('€49.00 per seat per month, excl. VAT');
    expect(html).toContain('Day 14 of the month');
    expect(html).toContain('Team');
    expect(html).toContain(en.scheduled.yearly);
    expect(html).not.toContain('data-notice');
    // The staff commands for this workspace.
    expect(html).toContain('retry-now ws_1');
  });

  it('flags a past-due account with its open charge', () => {
    const html = card({
      scheduled: null,
      pastDue: {
        since: '2027-01-14T10:30:00.000Z',
        remindedAt: '2027-01-21T10:30:00.000Z',
        charge: {
          id: 'bpy_1',
          providerPaymentId: 'tr_1',
          amount: 12100,
          currency: 'EUR',
          status: 'failed',
          failureMessage: 'insufficient funds',
        },
      },
    });
    expect(html).toContain('data-notice');
    expect(html).toContain(en.pastDueBadge);
    expect(html).toContain('Open charge tr_1 (bpy_1): €121.00 (failed).');
    expect(html).toContain('Last failure: insufficient funds');
    expect(html).toContain('Billing owners last reminded on 21 Jan 2027.');
    expect(html).not.toContain('Team');
  });

  it('leaves out the billing day without an anchor', () => {
    expect(card({ anchorDay: null })).not.toContain('Day 14 of the month');
  });
});
