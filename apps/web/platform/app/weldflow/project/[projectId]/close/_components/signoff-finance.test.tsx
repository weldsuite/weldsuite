import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({ request: { mutateAsync: vi.fn(), isPending: false } }));
vi.mock('@/hooks/queries/use-project-closing-queries', () => ({ useRequestSignOff: () => api.request }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FinanceCard } from './finance-card';
import { SignOffCard } from './signoff-card';
import { NO_ABILITIES, Providers, contextValue, makeChecklist } from '../_lib/test-fixtures';

beforeEach(() => {
  api.request.mutateAsync.mockReset().mockResolvedValue({});
});

function setup(ui: React.ReactElement, overrides: Parameters<typeof contextValue>[0] = {}) {
  render(<Providers value={contextValue(overrides)}>{ui}</Providers>);
}

const ready = makeChecklist({
  canRequest: true,
  checks: makeChecklist().checks.map((check) => ({ ...check, done: check.key !== 'signoff' && check.key !== 'lessons' ? true : check.done })),
});

describe('SignOffCard', () => {
  it('names the sponsor and disables the request while blocking checks are open', () => {
    setup(<SignOffCard />);
    expect(screen.getByRole('heading', { name: 'Sponsor sign-off · Noor Hendriks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request sign-off' })).toBeDisabled();
    expect(screen.getByText('2 blocking checks are still open: RAID items, Benefits')).toBeInTheDocument();
  });

  it('asks the sponsor for sign-off with a note', async () => {
    setup(<SignOffCard />, { checklist: ready });
    await userEvent.click(screen.getByRole('button', { name: 'Request sign-off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request sign-off' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'All set');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(api.request.mutateAsync).toHaveBeenCalledWith({ note: 'All set' });
  });

  it('shows a pending request as requested, and no way to send another', () => {
    const checklist = makeChecklist({
      canRequest: false,
      signOff: {
        state: 'pending',
        sponsorId: 'u_noor',
        approval: { id: 'ap_1', approverId: 'u_noor', decision: 'pending', note: null, decidedAt: null, decidedBy: null, delegatedFrom: null, requestedAt: '2026-11-03T10:00:00.000Z' },
      },
    });
    setup(<SignOffCard />, { checklist });
    expect(screen.getByRole('button', { name: 'Sign-off requested' })).toBeDisabled();
  });

  it('sends the approver to My reviews', () => {
    const checklist = makeChecklist({
      signOff: {
        state: 'pending',
        sponsorId: 'u_noor',
        approval: { id: 'ap_1', approverId: 'u_noor', decision: 'pending', note: null, decidedAt: null, decidedBy: null, delegatedFrom: null, requestedAt: '2026-11-03T10:00:00.000Z' },
      },
    });
    setup(<SignOffCard />, { checklist, userId: 'u_noor', abilities: NO_ABILITIES, isManager: false });
    expect(screen.getByRole('link', { name: 'Open My reviews' })).toHaveAttribute('href', '/weldflow/reviews');
  });

  it('shows the sponsor note of a declined request', () => {
    const checklist = makeChecklist({
      signOff: {
        state: 'rejected',
        sponsorId: 'u_noor',
        approval: { id: 'ap_1', approverId: 'u_noor', decision: 'rejected', note: 'Finance is not final', decidedAt: '2026-11-04T10:00:00.000Z', decidedBy: 'u_noor', delegatedFrom: null, requestedAt: '2026-11-03T10:00:00.000Z' },
      },
    });
    setup(<SignOffCard />, { checklist });
    expect(screen.getByText('Finance is not final')).toBeInTheDocument();
  });

  it('shows Closed for a closed project and no request button', () => {
    setup(<SignOffCard />, { checklist: makeChecklist({ closed: true }), abilities: NO_ABILITIES });
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request sign-off' })).not.toBeInTheDocument();
  });

  it('tells a member without manager rights who can ask', () => {
    setup(<SignOffCard />, { abilities: NO_ABILITIES, isManager: false });
    expect(screen.getByText('Only project managers can request sign-off.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request sign-off' })).not.toBeInTheDocument();
  });
});

describe('FinanceCard', () => {
  it('shows budget, actual and the overrun', () => {
    setup(<FinanceCard />);
    expect(screen.getByText('Budget (baseline v5)')).toBeInTheDocument();
    expect(screen.getByText('€193,900')).toBeInTheDocument();
    expect(screen.getByText('€195,200')).toBeInTheDocument();
    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByText('€1,300 · 0.7%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Finance' })).toHaveAttribute('href', '/weldflow/project/prj_1/finance');
  });

  it('shows only the verdict and the percentage without finance access', () => {
    const base = makeChecklist().finance;
    const checklist = makeChecklist({ finance: { ...base, amountsVisible: false, budget: null, actual: null, variance: null, timeCost: null } });
    setup(<FinanceCard />, { checklist });
    expect(screen.queryByText('€193,900')).not.toBeInTheDocument();
    expect(screen.queryByText('Actual')).not.toBeInTheDocument();
    expect(screen.getByText('Over budget')).toBeInTheDocument();
    expect(screen.getByText('0.7%')).toBeInTheDocument();
    expect(screen.getByText(/percentages only/)).toBeInTheDocument();
  });
});
