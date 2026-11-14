import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const jurisdiction = vi.hoisted(() => ({
  current: {} as {
    code: string | null;
    jurisdiction: { name: string } | null;
    features: { salesTax: boolean };
    isResolved: boolean;
    isError: boolean;
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => jurisdiction.current }));
vi.mock('@weldsuite/ui/components/page-loader', () => ({ PageLoader: () => <div>Loading jurisdiction</div> }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      accounting: {
        jurisdictionGate: {
          title: "{feature} isn't available for {country} entities",
          description: 'Only offered where it applies.',
          back: 'Back to the dashboard',
          unknownCountry: 'these',
        },
      },
    },
  }),
}));

import { JurisdictionGate, JurisdictionUnavailable } from './jurisdiction-gate';

function gate() {
  return (
    <JurisdictionGate when={(j) => j.features.salesTax} feature="Sales Tax">
      <p>The screen</p>
    </JurisdictionGate>
  );
}

beforeEach(() => {
  jurisdiction.current = {
    code: 'US',
    jurisdiction: { name: 'United States' },
    features: { salesTax: true },
    isResolved: true,
    isError: false,
  };
});

describe('JurisdictionGate', () => {
  it('shows the screen when the jurisdiction passes', () => {
    render(gate());
    expect(screen.getByText('The screen')).toBeInTheDocument();
  });

  it('shows one not-available screen, naming feature and country, with a way back', () => {
    jurisdiction.current = {
      code: 'NL',
      jurisdiction: { name: 'Netherlands' },
      features: { salesTax: false },
      isResolved: true,
      isError: false,
    };
    render(gate());

    expect(screen.getByText("Sales Tax isn't available for Netherlands entities")).toBeInTheDocument();
    expect(screen.getByText('Only offered where it applies.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '/weldbooks/dashboard');
    expect(screen.queryByText('The screen')).not.toBeInTheDocument();
  });

  it('waits for the jurisdiction instead of assuming one', () => {
    jurisdiction.current = { ...jurisdiction.current, jurisdiction: null, isResolved: false };
    render(gate());
    expect(screen.getByText('Loading jurisdiction')).toBeInTheDocument();
    expect(screen.queryByText('The screen')).not.toBeInTheDocument();
  });

  it('shows an error state when the jurisdiction cannot be loaded', () => {
    jurisdiction.current = { ...jurisdiction.current, jurisdiction: null, isResolved: false, isError: true };
    render(gate());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('The screen')).not.toBeInTheDocument();
  });
});

describe('JurisdictionUnavailable', () => {
  it('falls back to a neutral country word and takes its own title and description', () => {
    const { rerender } = render(<JurisdictionUnavailable feature="Deposits" />);
    expect(screen.getByText("Deposits isn't available for these entities")).toBeInTheDocument();

    rerender(<JurisdictionUnavailable feature="Deposits" title="Own title" description="Own text" />);
    expect(screen.getByText('Own title')).toBeInTheDocument();
    expect(screen.getByText('Own text')).toBeInTheDocument();
  });
});
