import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { OutboundUsage } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import MailSendingLimitsSettingsPage from './page';

const state = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false },
  locale: 'en' as 'en' | 'nl',
}));

vi.mock('@/hooks/queries/use-mail-sending-queries', () => ({
  useMailSendingUsage: () => state.query,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return {
    useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale }),
  };
});

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/page-loader', () => ({ PageLoader: () => <div data-testid="page-loader" /> }));
vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const tl = en.settings.weldmail.limits;

function usage(overrides: Partial<OutboundUsage> = {}): OutboundUsage {
  return {
    mode: 'enforce',
    trustLevel: 'new',
    state: 'active',
    stateReason: null,
    limits: {
      recipientsPerMessage: 20,
      senderPerHour: 30,
      senderPerDay: 150,
      workspacePerDay: 300,
      firstContactPerDay: 50,
      repliesPerSenderPerDay: 150,
      monthlyRecipients: null,
    },
    workspace: {
      hour: 4,
      day: { used: 120, limit: 300 },
      firstContactDay: { used: 45, limit: 50 },
      month: { used: 1_234, limit: null },
    },
    senders: [
      { email: 'anna@example.com', hour: { used: 4, limit: 30 }, day: { used: 120, limit: 150 } },
      { email: 'bob@example.com', hour: { used: 0, limit: 30 }, day: { used: 0, limit: 150 } },
    ],
    deliveries7d: { delivered: 980, hardBounces: 3, softBounces: 12, complaints: 1, rejected: 2 },
    coldOutreachCapped: false,
    ...overrides,
  };
}

beforeEach(() => {
  state.query = { data: undefined, isLoading: false };
  state.locale = 'en';
});

describe('MailSendingLimitsSettingsPage', () => {
  it('shows a loader while the usage loads', () => {
    state.query = { data: undefined, isLoading: true };
    render(<MailSendingLimitsSettingsPage />);
    expect(screen.getByTestId('page-loader')).toBeInTheDocument();
  });

  it('hides gracefully when there is no data', () => {
    state.query = { data: null, isLoading: false };
    render(<MailSendingLimitsSettingsPage />);
    expect(screen.getByText(tl.unavailableTitle)).toBeInTheDocument();
    expect(screen.queryByText(tl.usageTitle)).not.toBeInTheDocument();
  });

  it('shows trust level, state, usage against each limit and what a new contact is', () => {
    state.query = { data: usage(), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);

    expect(screen.getByText(tl.trust.new)).toBeInTheDocument();
    expect(screen.getByText(tl.trustHint.new)).toBeInTheDocument();
    expect(screen.getByText(tl.state.active)).toBeInTheDocument();

    expect(screen.getByText('120 of 300')).toBeInTheDocument();
    expect(screen.getByText('45 of 50')).toBeInTheDocument();
    expect(screen.getByText('1,234 used')).toBeInTheDocument();
    expect(screen.getByText(tl.noMonthlyCap)).toBeInTheDocument();
    expect(screen.getByText(tl.newContactsHint)).toBeInTheDocument();
    expect(screen.getByText('Up to 20 recipients per message.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(tl.shadowNote)).not.toBeInTheDocument();
  });

  it('lists each sender address with its hour and day usage', () => {
    state.query = { data: usage(), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);

    const anna = screen.getByText('anna@example.com').closest('li') as HTMLElement;
    expect(within(anna).getByText('4 of 30')).toBeInTheDocument();
    expect(within(anna).getByText('120 of 150')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('says so when no address sent anything', () => {
    state.query = { data: usage({ senders: [] }), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);
    expect(screen.getByText(tl.noAddresses)).toBeInTheDocument();
  });

  it('shows the 7-day deliveries', () => {
    state.query = { data: usage(), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);

    const delivered = screen.getByText(tl.delivered).parentElement as HTMLElement;
    expect(delivered).toHaveTextContent('980');
    expect(screen.getByText(tl.hardBounces).parentElement).toHaveTextContent('3');
    expect(screen.getByText(tl.softBounces).parentElement).toHaveTextContent('12');
    expect(screen.getByText(tl.complaints).parentElement).toHaveTextContent('1');
    expect(screen.getByText(tl.rejected).parentElement).toHaveTextContent('2');
  });

  it('shows the customer-facing reason and a restricted state', () => {
    state.query = {
      data: usage({ state: 'restricted', stateReason: 'Too many bounces last week.' }),
      isLoading: false,
    };
    render(<MailSendingLimitsSettingsPage />);

    expect(screen.getByText(tl.state.restricted)).toBeInTheDocument();
    expect(screen.getByText('Too many bounces last week.')).toBeInTheDocument();
  });

  it('notes that limits are measured but not enforced in shadow mode', () => {
    state.query = { data: usage({ mode: 'shadow' }), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);
    expect(screen.getByText(tl.shadowNote)).toBeInTheDocument();
  });

  it('points a capped cold-outreach template at WeldReach', () => {
    state.query = { data: usage({ coldOutreachCapped: true }), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);

    expect(screen.getByText(tl.coldCappedTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: tl.requestWeldReach })).toHaveAttribute('href', '/appstore/weldreach');
  });

  it('reads in Dutch', () => {
    state.locale = 'nl';
    state.query = { data: usage(), isLoading: false };
    render(<MailSendingLimitsSettingsPage />);

    expect(screen.getByText(nl.settings.weldmail.limits.trust.new)).toBeInTheDocument();
    expect(screen.getByText('120 van 300')).toBeInTheDocument();
  });
});
