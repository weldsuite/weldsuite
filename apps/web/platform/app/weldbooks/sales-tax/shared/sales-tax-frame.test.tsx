import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

const jurisdiction = vi.hoisted(() => ({
  current: { features: { salesTax: true }, isResolved: true, isError: false } as {
    features: { salesTax: boolean };
    isResolved: boolean;
    isError: boolean;
  },
}));
const router = vi.hoisted(() => ({ pathname: '/weldbooks/sales-tax' }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode; 'aria-current'?: 'page' }) => (
    <a href={to} aria-current={rest['aria-current']}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: router.pathname } }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => jurisdiction.current }));
vi.mock('@/components/page-loader', () => ({ PageLoader: () => <div>Loading jurisdiction</div> }));

import { SalesTaxFrame, SalesTaxGate, sectionOf } from './sales-tax-frame';
import { renderWithProviders } from './test-support';

beforeEach(() => {
  jurisdiction.current = { features: { salesTax: true }, isResolved: true, isError: false };
  router.pathname = '/weldbooks/sales-tax';
});

describe('sectionOf', () => {
  it('names the section of a path', () => {
    expect(sectionOf('/weldbooks/sales-tax')).toBe('overview');
    expect(sectionOf('/weldbooks/sales-tax/')).toBe('overview');
    expect(sectionOf('/weldbooks/sales-tax/returns')).toBe('returns');
    expect(sectionOf('/weldbooks/sales-tax/returns/txr_1')).toBe('returns');
    expect(sectionOf('/weldbooks/sales-tax/reports')).toBe('reports');
    expect(sectionOf('/weldbooks/sales-tax/certificates/reports')).toBe('certificates');
    expect(sectionOf('/weldbooks/sales-tax/nexus/CA')).toBe('nexus');
  });

  it('is the overview for anything else', () => {
    expect(sectionOf('/weldbooks/sales-tax/agencies')).toBe('overview');
  });
});

describe('SalesTaxGate', () => {
  it('shows the screen for an entity whose jurisdiction has sales tax', () => {
    renderWithProviders(
      <SalesTaxGate>
        <p>The screen</p>
      </SalesTaxGate>,
    );
    expect(screen.getByText('The screen')).toBeInTheDocument();
  });

  it('says sales tax is not available for any other jurisdiction, and does not render the screen', () => {
    jurisdiction.current = { features: { salesTax: false }, isResolved: true, isError: false };
    renderWithProviders(
      <SalesTaxGate>
        <p>The screen</p>
      </SalesTaxGate>,
    );

    expect(screen.getByText('Sales tax is not available for this entity')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute('href', '/weldbooks/dashboard');
    expect(screen.queryByText('The screen')).not.toBeInTheDocument();
  });

  it('waits for the jurisdiction instead of assuming one', () => {
    jurisdiction.current = { features: { salesTax: false }, isResolved: false, isError: false };
    renderWithProviders(
      <SalesTaxGate>
        <p>The screen</p>
      </SalesTaxGate>,
    );

    expect(screen.getByText('Loading jurisdiction')).toBeInTheDocument();
    expect(screen.queryByText('The screen')).not.toBeInTheDocument();
    expect(screen.queryByText('Sales tax is not available for this entity')).not.toBeInTheDocument();
  });

  it('lets the API answer when the jurisdictions cannot be loaded', () => {
    jurisdiction.current = { features: { salesTax: false }, isResolved: false, isError: true };
    renderWithProviders(
      <SalesTaxGate>
        <p>The screen</p>
      </SalesTaxGate>,
    );
    expect(screen.getByText('The screen')).toBeInTheDocument();
  });
});

describe('SalesTaxFrame', () => {
  it('shows the title, the subtitle and the sections, marking the one the path belongs to', () => {
    router.pathname = '/weldbooks/sales-tax/nexus/TX';
    renderWithProviders(
      <SalesTaxFrame title="Nexus monitor" subtitle="Sales per state" actions={<button type="button">Act</button>}>
        <p>Body</p>
      </SalesTaxFrame>,
    );

    expect(screen.getByRole('heading', { name: 'Nexus monitor' })).toBeInTheDocument();
    expect(screen.getByText('Sales per state')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/weldbooks/sales-tax',
      '/weldbooks/sales-tax/returns',
      '/weldbooks/sales-tax/reports',
      '/weldbooks/sales-tax/certificates/reports',
      '/weldbooks/sales-tax/nexus',
    ]);
    expect(screen.getByRole('link', { name: 'Nexus' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('shows the notice instead of the sections for a non-US entity', () => {
    jurisdiction.current = { features: { salesTax: false }, isResolved: true, isError: false };
    renderWithProviders(
      <SalesTaxFrame title="Nexus monitor">
        <p>Body</p>
      </SalesTaxFrame>,
    );

    expect(screen.getByText('Sales tax is not available for this entity')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });
});
