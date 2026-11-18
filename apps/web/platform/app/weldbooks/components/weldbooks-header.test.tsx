import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const env = vi.hoisted(() => ({ pathname: '/weldbooks', search: '', segments: [] as Array<{ label: string }> }));

vi.mock('@/lib/router', () => ({
  usePathname: () => env.pathname,
  useSearchParams: () => new URLSearchParams(env.search),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/components/breadcrumb-header', () => ({
  BreadcrumbHeader: ({ segments }: { segments: Array<{ label: string }> }) => {
    env.segments = segments;
    return null;
  },
}));

import { WeldbooksHeader } from './weldbooks-header';

const labelsFor = (pathname: string) => {
  env.pathname = pathname;
  render(<WeldbooksHeader />);
  return env.segments.map((s) => s.label);
};

describe('WeldbooksHeader breadcrumbs', () => {
  beforeEach(() => {
    env.segments = [];
    env.search = '';
  });

  it('puts the new-supplier form under Suppliers, the new-customer form under Customers', () => {
    env.search = 'role=supplier';
    expect(labelsFor('/weldbooks/customers/add')).toEqual(['WeldBooks', 'Suppliers', en.accounting.header.add]);
    env.search = '';
    expect(labelsFor('/weldbooks/customers/add')).toEqual(['WeldBooks', 'Customers', en.accounting.header.add]);
  });

  it('names the pages that used to fall back to their URL', () => {
    expect(labelsFor('/weldbooks/received-nfe')).toEqual(['WeldBooks', en.navigation.moduleSidebar.weldbooks.receivedNfe]);
    expect(labelsFor('/weldbooks/dashboard/builder')).toEqual(['WeldBooks', 'Dashboard', 'Dashboard builder']);
    expect(labelsFor('/weldbooks/settings/invoice-templates')).toEqual(['WeldBooks', 'Settings', 'Invoice templates']);
    expect(labelsFor('/weldbooks/banking/feeds/callback')).toEqual(['WeldBooks', 'Bank accounts', 'Bank Feeds', 'Bank connection']);
  });

  it('calls the banking page "Bank accounts" and the 1099 page by its title', () => {
    expect(labelsFor('/weldbooks/banking')).toEqual(['WeldBooks', 'Bank accounts']);
    expect(labelsFor('/weldbooks/form-1099')).toEqual(['WeldBooks', en.weldbooksUs.form1099.center.title]);
  });
});
