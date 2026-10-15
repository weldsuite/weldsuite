import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OutboundUsage } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { SendingRestrictionBanner, isSendingRestricted } from './sending-restriction-banner';

const state = vi.hoisted(() => ({
  usage: undefined as unknown,
  locale: 'en' as 'en' | 'nl',
}));

vi.mock('@/hooks/queries/use-mail-sending-queries', () => ({
  useMailSendingUsage: () => ({ data: state.usage }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english }) };
});

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

function usage(overrides: Partial<OutboundUsage> = {}): OutboundUsage {
  return {
    mode: 'enforce',
    trustLevel: 'standard',
    state: 'restricted',
    stateReason: null,
    limits: {
      recipientsPerMessage: 10,
      senderPerHour: 10,
      senderPerDay: 50,
      workspacePerDay: 200,
      firstContactPerDay: 0,
      repliesPerSenderPerDay: 200,
      monthlyRecipients: null,
    },
    workspace: {
      hour: 0,
      day: { used: 0, limit: 200 },
      firstContactDay: { used: 0, limit: 0 },
      month: { used: 0, limit: null },
    },
    senders: [],
    deliveries7d: { delivered: 0, hardBounces: 0, softBounces: 0, complaints: 0, rejected: 0 },
    coldOutreachCapped: false,
    ...overrides,
  };
}

beforeEach(() => {
  state.usage = undefined;
  state.locale = 'en';
});

describe('isSendingRestricted', () => {
  it('is true only for a restricted state that is enforced', () => {
    expect(isSendingRestricted(usage())).toBe(true);
    expect(isSendingRestricted(usage({ state: 'hold' }))).toBe(true);
    expect(isSendingRestricted(usage({ state: 'suspended' }))).toBe(true);
    expect(isSendingRestricted(usage({ state: 'active' }))).toBe(false);
    expect(isSendingRestricted(usage({ mode: 'shadow' }))).toBe(false);
    expect(isSendingRestricted(null)).toBe(false);
    expect(isSendingRestricted(undefined)).toBe(false);
  });
});

describe('SendingRestrictionBanner', () => {
  it('renders nothing while loading, without data or when sending is normal', () => {
    for (const value of [undefined, null, usage({ state: 'active' })]) {
      state.usage = value;
      const { container, unmount } = render(<SendingRestrictionBanner />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('renders nothing in shadow mode: nothing is blocked yet', () => {
    state.usage = usage({ mode: 'shadow', state: 'restricted' });
    const { container } = render(<SendingRestrictionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains a restriction, says replies still work and links to the limits', () => {
    state.usage = usage();
    render(<SendingRestrictionBanner />);

    const banner = screen.getByTestId('mail-sending-restriction-banner');
    expect(banner).toHaveTextContent(en.mail.sending.banner.restrictedTitle);
    expect(banner).toHaveTextContent(en.mail.sending.banner.restricted);
    expect(banner).toHaveTextContent(en.mail.sending.banner.repliesStillWork);
    expect(banner).toHaveTextContent(en.mail.sending.banner.contactSupport);
    expect(screen.getByRole('link', { name: en.mail.sending.banner.viewLimits })).toHaveAttribute(
      'href',
      '/settings/apps/weldmail?tab=limits',
    );
  });

  it('prefers the reason staff left for the customer', () => {
    state.usage = usage({ state: 'hold', stateReason: 'We are checking a spike in bounces.' });
    render(<SendingRestrictionBanner />);

    const banner = screen.getByTestId('mail-sending-restriction-banner');
    expect(banner).toHaveTextContent(en.mail.sending.banner.holdTitle);
    expect(banner).toHaveTextContent('We are checking a spike in bounces.');
    expect(banner).not.toHaveTextContent(en.mail.sending.banner.hold);
    expect(banner).toHaveTextContent(en.mail.sending.banner.repliesStillWork);
  });

  it('does not promise replies while suspended', () => {
    state.usage = usage({ state: 'suspended' });
    render(<SendingRestrictionBanner />);

    const banner = screen.getByTestId('mail-sending-restriction-banner');
    expect(banner).toHaveTextContent(en.mail.sending.banner.suspendedTitle);
    expect(banner).not.toHaveTextContent(en.mail.sending.banner.repliesStillWork);
  });

  it('reads in Dutch', () => {
    state.locale = 'nl';
    state.usage = usage({ state: 'hold' });
    render(<SendingRestrictionBanner />);

    const banner = screen.getByTestId('mail-sending-restriction-banner');
    expect(banner).toHaveTextContent(nl.mail.sending.banner.holdTitle);
    expect(banner).toHaveTextContent(nl.mail.sending.banner.repliesStillWork);
  });
});
