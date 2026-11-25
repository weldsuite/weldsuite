// The seat price dialog and its server function, in node: the dialog shell
// renders its children inline, and the server function calls its handler.

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '@/actions/workspaces';
import type { MollieBillingAccount, WorkspaceBilling } from './billing-types';

type DialogProps = {
  title: ReactNode;
  description?: ReactNode;
  submitLabel: string;
  children?: ReactNode;
  onSubmit: (reason: string, requestId: string) => Promise<ActionResult<unknown>>;
};

const seen = vi.hoisted(() => ({ dialog: null as DialogProps | null }));
const server = vi.hoisted(() => ({ setSeatPrice: vi.fn() }));

vi.mock('@/components/billing/action-dialog', () => ({
  ActionDialog: (props: DialogProps) => {
    seen.dialog = props;
    return createElement('section', null, props.title, props.description, props.submitLabel, props.children);
  },
  Field: ({ label, htmlFor, children }: { label: ReactNode; htmlFor?: string; children: ReactNode }) =>
    createElement('div', null, createElement('label', { htmlFor }, label), children),
}));

// The server function as TanStack Start builds it, minus the network: the
// validator runs, then the handler.
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let schema: { parse: (data: unknown) => unknown } | null = null;
    const builder = {
      middleware: () => builder,
      validator: (s: { parse: (data: unknown) => unknown }) => {
        schema = s;
        return builder;
      },
      handler:
        (handle: (ctx: { data: unknown }) => unknown) =>
        ({ data }: { data: unknown }) =>
          handle({ data: schema ? schema.parse(data) : data }),
    };
    return builder;
  },
}));
vi.mock('@/lib/edition', () => ({ kubernetesOnly: {} }));
vi.mock('@/actions/seat-price.server', () => server);

import { SeatPriceDialog } from '@/app/workspaces/[id]/billing/seat-price-dialog';
import { setSeatPrice } from '@/actions/seat-price';
import { mollieBillingCopyByLocale } from './mollie-billing-copy';

const en = mollieBillingCopyByLocale.en;

const account = {
  unitAmount: 2000,
  currency: 'EUR',
  nextChargeAt: '2026-12-14T10:00:00.000Z',
  scheduled: null,
} as MollieBillingAccount;

const billing = {
  planId: 'plan_business',
  purchasedSeats: 3,
  subscriptionStatus: 'active',
  subscriptionCycle: 'monthly',
  currentPeriodEnd: '2026-12-14T10:00:00.000Z',
} as WorkspaceBilling;

function dialog(
  over: { account?: Partial<MollieBillingAccount>; billing?: Partial<WorkspaceBilling>; listPrice?: number | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(SeatPriceDialog, {
      workspaceId: 'ws_1',
      account: { ...account, ...over.account },
      billing: { ...billing, ...over.billing },
      planName: 'Business',
      listPrice: over.listPrice === undefined ? 2500 : over.listPrice,
      onClose: () => undefined,
    }),
  );
}

beforeEach(() => {
  seen.dialog = null;
  server.setSeatPrice.mockReset();
});

describe('SeatPriceDialog', () => {
  it('shows the current and list price, when the price starts and when it ends', () => {
    const html = dialog();
    expect(html).toContain('What this workspace pays per seat for Business');
    expect(html).toContain('€20.00 per seat per month');
    expect(html).toContain('€25.00 per seat per month');
    expect(html).toContain(en.seatPriceDialog.useList);
    expect(html).toContain('The renewal on 14 Dec 2026 charges the new price.');
    expect(html).toContain(en.seatPriceDialog.ends);
    expect(html).toContain('inputMode="decimal"');
    expect(html).not.toContain('scheduled for');
    expect(seen.dialog?.submitLabel).toBe(en.seatPriceDialog.submit);
  });

  it('warns when a plan or cycle change is scheduled', () => {
    const html = dialog({ account: { scheduled: { planId: 'plan_starter', planName: 'Starter', seats: null, cycle: null } } });
    expect(html).toContain('A change of plan or billing cycle is scheduled for 14 Dec 2026');
  });

  it('prices per year on a yearly cycle, and offers no list price a plan lacks', () => {
    const html = dialog({ billing: { subscriptionCycle: 'yearly' }, listPrice: null });
    expect(html).toContain('€20.00 per seat per year');
    expect(html).toContain(en.none);
    expect(html).not.toContain(en.seatPriceDialog.useList);
  });

  it('refuses to save an empty amount without calling the server', async () => {
    dialog();
    const result = await seen.dialog!.onSubmit('Launch discount', 'req_1');
    expect(result).toEqual({ ok: false, error: en.seatPriceDialog.errors.format });
    expect(server.setSeatPrice).not.toHaveBeenCalled();
  });
});

describe('setSeatPrice server function', () => {
  it('hands checked input to the server write', async () => {
    server.setSeatPrice.mockResolvedValue({ ok: true, data: { unitAmount: 1950, previous: 2500 } });
    const input = { workspaceId: 'ws_1', unitAmount: 1950, reason: 'Launch discount' };
    expect(await setSeatPrice(input)).toEqual({ ok: true, data: { unitAmount: 1950, previous: 2500 } });
    expect(server.setSeatPrice).toHaveBeenCalledWith(input);
  });

  it('refuses input that isn’t whole cents for a named workspace', () => {
    expect(() => setSeatPrice({ workspaceId: 'ws_1', unitAmount: 19.5, reason: 'x' })).toThrow();
    expect(() => setSeatPrice({ workspaceId: '', unitAmount: 1950, reason: 'x' })).toThrow();
    expect(server.setSeatPrice).not.toHaveBeenCalled();
  });
});
