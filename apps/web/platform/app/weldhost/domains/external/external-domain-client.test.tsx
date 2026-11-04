import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { ExternalDomainClient } from './external-domain-client';

const mutateAsync = vi.fn();
const toastError = vi.fn();
const routerReplace = vi.fn();
let searchParams = new URLSearchParams();
let domainQuery: { data?: { data: unknown }; isError: boolean; isFetching: boolean } = {
  isError: false,
  isFetching: false,
};

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => searchParams,
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/hooks/queries/use-host-queries', () => {
  const idle = { mutateAsync: vi.fn(), isPending: false };
  const scanning = { mutateAsync: vi.fn(() => new Promise(() => {})), isPending: true };
  return {
    useAddExternalDomain: () => ({ mutateAsync, isPending: false }),
    useDomain: () => domainQuery,
    useVerifyDomainOwnership: () => idle,
    useScanDnsRecords: () => scanning,
    useImportDnsRecords: () => idle,
  };
});

const tx = en.host.externalDomain;

function typeDomain(value: string) {
  fireEvent.change(screen.getByLabelText(/Domain Name/), { target: { value } });
}

function submit() {
  fireEvent.submit(screen.getByLabelText(/Domain Name/).closest('form')!);
}

describe('ExternalDomainClient, step 1', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    toastError.mockReset();
    searchParams = new URLSearchParams();
  });

  it('shows an invalid domain under the field instead of calling the API', () => {
    render(<ExternalDomainClient />);
    typeDomain('not a domain');
    submit();

    expect(document.getElementById('domain-error')).toHaveTextContent(tx.errorInvalidDomain);
    expect(screen.getByLabelText(/Domain Name/)).toHaveAttribute('aria-invalid', 'true');
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('rejects a reserved TLD up front', () => {
    render(<ExternalDomainClient />);
    typeDomain('e2e-weldtest.example');
    submit();

    expect(document.getElementById('domain-error')).toHaveTextContent(tx.errorReservedTld);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('does not echo an invalid value in the summary', () => {
    render(<ExternalDomainClient />);
    typeDomain('not a domain');

    expect(screen.queryByText('not a domain')).toBeNull();
    expect(screen.getAllByText(tx.invalidDomain).length).toBeGreaterThan(0);
  });

  it('sends a valid domain, normalised', () => {
    mutateAsync.mockReturnValue(new Promise(() => {}));
    render(<ExternalDomainClient />);
    typeDomain(' Example.COM ');
    submit();

    expect(document.getElementById('domain-error')).toBeNull();
    expect(mutateAsync).toHaveBeenCalledWith({ domain: 'example.com', registrar: undefined });
    expect(screen.getAllByText('example.com').length).toBeGreaterThan(0);
  });
});

describe('ExternalDomainClient, resuming a pending domain', () => {
  const pendingDomain = {
    id: 'dom_pending',
    fullDomain: 'pending.com',
    registrar: 'GoDaddy',
    nameservers: null,
    verificationRecord: {
      name: '_weldhost-verify.pending.com',
      type: 'TXT',
      value: 'weldhost-verify=abc',
    },
  };

  beforeEach(() => {
    routerReplace.mockReset();
    searchParams = new URLSearchParams({ domain: 'dom_pending' });
  });

  it('opens on the TXT record while the domain is unverified', () => {
    domainQuery = { data: { data: pendingDomain }, isError: false, isFetching: false };
    render(<ExternalDomainClient />);

    expect(screen.getByText(tx.verifyTitle)).toBeInTheDocument();
    expect(screen.getByText('weldhost-verify=abc')).toBeInTheDocument();
  });

  it('waits for a refetch instead of resuming from a stale row', () => {
    domainQuery = { data: { data: pendingDomain }, isError: false, isFetching: true };
    render(<ExternalDomainClient />);

    expect(screen.queryByText(tx.verifyTitle)).toBeNull();
  });

  it('continues at the import step once the domain is verified', () => {
    domainQuery = {
      data: { data: { ...pendingDomain, verificationRecord: null, nameservers: ['a.ns.cloudflare.com'] } },
      isError: false,
      isFetching: false,
    };
    render(<ExternalDomainClient />);

    expect(screen.getByText(tx.importTitle)).toBeInTheDocument();
  });

  it('sends a managed domain back to its own page', () => {
    domainQuery = {
      data: { data: { ...pendingDomain, registrar: 'WeldSuite', verificationRecord: null } },
      isError: false,
      isFetching: false,
    };
    render(<ExternalDomainClient />);

    expect(routerReplace).toHaveBeenCalledWith('/weldhost/domains/dom_pending');
  });
});
