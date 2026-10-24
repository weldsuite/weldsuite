import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppRailBadge, RailIconCorner, formatRailBadgeCount } from './app-rail-badge';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: { navigation: { unreadBadge: '{count} unread' } } }),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => (key === 'sweep.shared.beta' ? 'BETA' : key),
}));

describe('AppRailBadge', () => {
  it('renders nothing when there is nothing unread', () => {
    const { container } = render(<AppRailBadge count={0} />);
    expect(container).toBeEmptyDOMElement();
    expect(render(<AppRailBadge />).container).toBeEmptyDOMElement();
  });

  it('shows the count with a screen-reader label', () => {
    render(<AppRailBadge count={7} />);
    const badge = screen.getByTestId('app-rail-badge');
    expect(badge).toHaveTextContent('7');
    expect(badge).toHaveClass('w-[22px]');
    expect(screen.getByText('7 unread')).toHaveClass('sr-only');
  });

  it('widens for two digits', () => {
    render(<AppRailBadge count={42} />);
    expect(screen.getByTestId('app-rail-badge')).toHaveClass('min-w-[26px]');
  });

  it('caps the visible count at 99+ but keeps the real count for screen readers', () => {
    render(<AppRailBadge count={150} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
    expect(screen.getByText('150 unread')).toBeInTheDocument();
    expect(screen.getByTestId('app-rail-badge')).toHaveClass('min-w-[32px]');
  });
});

describe('formatRailBadgeCount', () => {
  it('formats counts', () => {
    expect(formatRailBadgeCount(1)).toBe('1');
    expect(formatRailBadgeCount(99)).toBe('99');
    expect(formatRailBadgeCount(100)).toBe('99+');
  });
});

describe('RailIconCorner', () => {
  it('shows the unread badge instead of BETA while there is a count', () => {
    render(<RailIconCorner badgeCount={3} showBeta />);
    expect(screen.getByTestId('app-rail-badge')).toHaveTextContent('3');
    expect(screen.queryByText('BETA')).not.toBeInTheDocument();
  });

  it('falls back to BETA when nothing is unread', () => {
    render(<RailIconCorner badgeCount={0} showBeta />);
    expect(screen.getByText('BETA')).toBeInTheDocument();
    expect(screen.queryByTestId('app-rail-badge')).not.toBeInTheDocument();
  });

  it('renders nothing without a count or BETA', () => {
    const { container } = render(<RailIconCorner />);
    expect(container).toBeEmptyDOMElement();
  });
});
