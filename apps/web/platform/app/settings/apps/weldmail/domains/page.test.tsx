import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MailDomainRow } from '@weldsuite/app-api-client/domains/mail-domains';
import { en } from '@weldsuite/i18n/locales/en';
import { setRuntimeConfig } from '@/lib/runtime-config';
import MailDomainsSettingsPage from './page';

const state = vi.hoisted(() => ({
  settings: { data: undefined as unknown, isLoading: false },
  create: vi.fn(),
  verify: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/hooks/queries/use-app-settings-queries', () => ({
  useMailAppSettings: () => state.settings,
}));

vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useCreateMailDomain: () => ({ mutateAsync: state.create, isPending: false }),
  useVerifyMailDomain: () => ({ mutateAsync: state.verify, isPending: false }),
  useDeleteMailDomain: () => ({ mutateAsync: state.remove, isPending: false }),
  useUpdateMailDomain: () => ({ mutateAsync: state.update, isPending: false }),
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@weldsuite/ui/components/page-loader', () => ({ PageLoader: () => <div data-testid="page-loader" /> }));
vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const td = en.settings.weldmail.domains;

function domain(overrides: Partial<MailDomainRow> = {}): MailDomainRow {
  return {
    id: 'mdom_1',
    domainName: 'acme.nl',
    isActive: true,
    isPrimary: false,
    mailProvider: 'mta',
    sendProvider: 'mta',
    receiveProvider: 'mta',
    maxEmailAccounts: 100,
    currentEmailAccounts: 0,
    dnsStatus: 'pending',
    dnsRecords: [
      {
        type: 'TXT',
        name: '_weldmail-verify.acme.nl',
        value: 'weldmail-verify=tok123',
        purpose: 'verification',
        verified: false,
      },
      { type: 'MX', name: 'acme.nl', value: 'mx.weldsuite.eu', priority: 10, purpose: 'mx', verified: true },
    ],
    verifiedAt: null,
    lastVerificationAttempt: null,
    spfVerified: false,
    dkimVerified: false,
    dmarcVerified: false,
    dkimSelector: 'ws1',
    dkimPublicKey: null,
    cloudflareZoneId: null,
    cloudflareRoutingEnabled: false,
    cloudflareRoutingRuleId: null,
    catchAllEnabled: false,
    catchAllAccountId: null,
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.settings = { data: { accounts: [], domains: [domain()], usage: null }, isLoading: false };
  for (const fn of [state.create, state.verify, state.remove, state.update, ...Object.values(state.toast)]) {
    fn.mockReset();
  }
});

afterEach(() => setRuntimeConfig(null));

describe('MailDomainsSettingsPage on Global', () => {
  it('keeps to catch-all: no way to add a domain and no DNS records', () => {
    render(<MailDomainsSettingsPage />);
    expect(screen.getByText(td.description)).toBeInTheDocument();
    expect(screen.queryByLabelText(td.addLabel)).not.toBeInTheDocument();
    expect(screen.queryByText('weldmail-verify=tok123')).not.toBeInTheDocument();
    expect(screen.getByText('acme.nl')).toBeInTheDocument();
  });
});

describe('MailDomainsSettingsPage on the Kubernetes editions', () => {
  beforeEach(() => setRuntimeConfig({ backend: 'rust' }));

  it('lists the records a pending domain must publish, the ownership record included', () => {
    render(<MailDomainsSettingsPage />);
    const row = screen.getByTestId('mail-domain-acme.nl');
    expect(within(row).getByText(td.statusPending)).toBeInTheDocument();
    expect(within(row).getByText(td.recordsHint)).toBeInTheDocument();
    expect(within(row).getByText('_weldmail-verify.acme.nl')).toBeInTheDocument();
    expect(within(row).getByText('weldmail-verify=tok123')).toBeInTheDocument();
    expect(within(row).getByText(td.purposes.verification)).toBeInTheDocument();
    expect(within(row).getByText(td.recordMissing)).toBeInTheDocument();
    expect(within(row).getByText(td.recordFound)).toBeInTheDocument();
    // Catch-all waits for a verified domain.
    expect(within(row).queryByText(td.catchAll)).not.toBeInTheDocument();
  });

  it('asks for the ownership record first while it is the only one', () => {
    state.settings = {
      data: {
        accounts: [],
        domains: [
          domain({
            dkimSelector: null,
            dnsRecords: [
              {
                type: 'TXT',
                name: '_weldmail-verify.acme.nl',
                value: 'weldmail-verify=tok123',
                purpose: 'verification',
                verified: false,
              },
            ],
          }),
        ],
        usage: null,
      },
      isLoading: false,
    };
    render(<MailDomainsSettingsPage />);
    const row = screen.getByTestId('mail-domain-acme.nl');
    expect(within(row).getByText(td.ownershipHint)).toBeInTheDocument();
    expect(within(row).queryByText(td.recordsHint)).not.toBeInTheDocument();
    expect(within(row).getByText('weldmail-verify=tok123')).toBeInTheDocument();
  });

  it('checks the DNS again and says when records are still missing', async () => {
    state.verify.mockResolvedValue({ data: domain() });
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.check }));
    await waitFor(() => expect(state.verify).toHaveBeenCalledWith('mdom_1'));
    await waitFor(() => expect(state.toast.info).toHaveBeenCalledWith(td.messages.stillPending));
  });

  it('hides the records of a verified domain until asked and offers catch-all', () => {
    state.settings = {
      data: { accounts: [], domains: [domain({ dnsStatus: 'verified' })], usage: null },
      isLoading: false,
    };
    render(<MailDomainsSettingsPage />);
    const row = screen.getByTestId('mail-domain-acme.nl');
    expect(within(row).getByText(td.statusVerified)).toBeInTheDocument();
    expect(within(row).queryByText('weldmail-verify=tok123')).not.toBeInTheDocument();
    expect(within(row).getAllByText(td.catchAll).length).toBeGreaterThan(0);
    fireEvent.click(within(row).getByRole('button', { name: td.showRecords }));
    expect(within(row).getByText('weldmail-verify=tok123')).toBeInTheDocument();
  });

  it('adds a domain, refusing a name that is not one', async () => {
    state.settings = { data: { accounts: [], domains: [], usage: null }, isLoading: false };
    state.create.mockResolvedValue({ data: domain() });
    render(<MailDomainsSettingsPage />);
    expect(screen.getByText(td.selfServedNoDomainsDescription)).toBeInTheDocument();
    const input = screen.getByLabelText(td.addLabel);

    fireEvent.change(input, { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: td.add }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(td.invalidDomain));
    expect(state.create).not.toHaveBeenCalled();

    // WeldMail's own domains stay with Global.
    fireEvent.change(input, { target: { value: 'acme.weldmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: td.add }));
    await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith(td.weldmailDomain));
    expect(state.create).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: ' Acme.NL ' } });
    fireEvent.click(screen.getByRole('button', { name: td.add }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith('acme.nl'));
    await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith(td.messages.added));
  });
});
