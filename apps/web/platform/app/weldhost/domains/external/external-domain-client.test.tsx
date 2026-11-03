import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { ExternalDomainClient } from './external-domain-client';

const mutateAsync = vi.fn();
const toastError = vi.fn();

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/hooks/queries/use-host-queries', () => {
  const idle = { mutateAsync: vi.fn(), isPending: false };
  return {
    useAddExternalDomain: () => ({ mutateAsync, isPending: false }),
    useVerifyDomainOwnership: () => idle,
    useScanDnsRecords: () => idle,
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
