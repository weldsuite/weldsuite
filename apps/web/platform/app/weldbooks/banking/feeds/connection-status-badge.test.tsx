import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { BankFeedConnectionStatus } from '@/lib/api/domains/weldbooks-bank-feeds';
import { ConnectionStatusBadge } from './connection-status-badge';
import { renderWithProviders } from './test-support';

const STATUSES: Array<[BankFeedConnectionStatus, string]> = [
  ['active', 'Connected'],
  ['reauth_required', 'Reconnect needed'],
  ['expiring', 'Expiring soon'],
  ['revoked', 'Access revoked'],
  ['disconnected', 'Disconnected'],
  ['error', 'Sync error'],
];

describe('ConnectionStatusBadge', () => {
  it.each(STATUSES)('shows %s as "%s"', (status, label) => {
    renderWithProviders(<ConnectionStatusBadge status={status} />);
    const badge = screen.getByText(label);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-status', status);
  });

  it('colors health: green when connected, amber when the user can fix it, red when it is broken', () => {
    const variants = STATUSES.map(([status, label]) => {
      const { unmount } = renderWithProviders(<ConnectionStatusBadge status={status} />);
      const className = screen.getByText(label).className;
      unmount();
      return [status, className] as const;
    });
    const byStatus = Object.fromEntries(variants);
    expect(byStatus.active).toContain('emerald');
    expect(byStatus.reauth_required).toContain('amber');
    expect(byStatus.expiring).toContain('amber');
    expect(byStatus.revoked).toContain('bg-destructive');
    expect(byStatus.error).toContain('bg-destructive');
    expect(byStatus.disconnected).toContain('bg-secondary');
  });

  it('is translated: every status has an English and a Dutch label', () => {
    for (const [status] of STATUSES) {
      expect(en.weldbooksUs.bankFeeds.status[status]).toBeTruthy();
      expect(nl.weldbooksUs.bankFeeds.status[status]).toBeTruthy();
    }
  });
});
