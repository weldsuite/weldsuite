import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DmarcSummary, MailDomainRow } from '@weldsuite/app-api-client/domains/mail-domains';
import { en } from '@weldsuite/i18n/locales/en';
import MailDomainsSettingsPage from './page';

const state = vi.hoisted(() => ({
  settings: { data: undefined as unknown, isLoading: false },
  create: vi.fn(),
  verify: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  dmarcAvailable: true,
  dmarc: { data: undefined as unknown, isLoading: false, isError: false },
  mark: vi.fn(),
}));

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  isFeatureAvailable: (feature: string) => feature === 'mail-dmarc-reports' && state.dmarcAvailable,
}));

vi.mock('@/hooks/queries/use-app-settings-queries', () => ({
  useMailAppSettings: () => state.settings,
}));

vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useCreateMailDomain: () => ({ mutateAsync: state.create, isPending: false }),
  useVerifyMailDomain: () => ({ mutateAsync: state.verify, isPending: false }),
  useDeleteMailDomain: () => ({ mutateAsync: state.remove, isPending: false }),
  useUpdateMailDomain: () => ({ mutateAsync: state.update, isPending: false }),
  useMailDmarcSummary: () => state.dmarc,
  useMarkDmarcSource: () => ({ mutateAsync: state.mark, isPending: false }),
}));

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('sonner', () => ({ toast: state.toast }));
vi.mock('@weldsuite/ui/components/page-loader', () => ({
  PageLoader: () => <div data-testid="page-loader" />,
}));
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
      {
        type: 'MX',
        name: 'acme.nl',
        value: 'mx.weldsuite.eu',
        priority: 10,
        purpose: 'mx',
        verified: true,
      },
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

function summary(overrides: Partial<DmarcSummary> = {}): DmarcSummary {
  return {
    domainId: 'mdom_1',
    domainName: 'acme.nl',
    reportAddress: 'r-abc@dmarc.weldsuite.eu',
    record: {
      state: 'ok',
      found: [],
      policy: null,
      reportsToWeldSuite: true,
      suggested: null,
    },
    period: {
      days: 30,
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-11-27T00:00:00.000Z',
    },
    totals: {
      messages: 200,
      passed: 197,
      dkimAligned: 197,
      spfAligned: 0,
      reports: 4,
      authenticatedReports: 4,
      lastReportAt: '2026-11-26T08:00:00.000Z',
    },
    sources: [],
    reporters: [],
    failures: [],
    advice: {
      current: 'none',
      next: 'quarantine',
      ready: false,
      suggestedRecord: null,
      blockers: [],
    },
    ...overrides,
  };
}

function verifiedSettings() {
  state.settings = {
    data: {
      accounts: [],
      domains: [domain({ dnsStatus: 'verified' })],
      usage: null,
    },
    isLoading: false,
  };
}

function withSummary(data: DmarcSummary) {
  state.dmarc = { data: { data }, isLoading: false, isError: false };
}

beforeEach(() => {
  state.dmarcAvailable = true;
  state.dmarc = { data: undefined, isLoading: false, isError: false };
  state.mark.mockReset();
  state.settings = {
    data: { accounts: [], domains: [domain()], usage: null },
    isLoading: false,
  };
  for (const fn of [
    state.create,
    state.verify,
    state.remove,
    state.update,
    ...Object.values(state.toast),
  ]) {
    fn.mockReset();
  }
});

describe('MailDomainsSettingsPage', () => {
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
      data: {
        accounts: [],
        domains: [domain({ dnsStatus: 'verified' })],
        usage: null,
      },
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
    state.settings = {
      data: { accounts: [], domains: [], usage: null },
      isLoading: false,
    };
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

describe('MailDomainsSettingsPage DMARC', () => {
  type Dmarc = NonNullable<NonNullable<MailDomainRow['dnsRecords']>[number]['dmarc']>;
  const withDmarcRecord = (dmarc: Dmarc) => {
    state.settings = {
      data: {
        accounts: [],
        domains: [
          domain({
            dnsRecords: [
              {
                type: 'TXT',
                name: '_dmarc.acme.nl',
                value: 'v=DMARC1; p=none; rua=mailto:r-abc@dmarc.weldsuite.eu',
                purpose: 'dmarc',
                verified: false,
                dmarc,
              },
            ],
          }),
        ],
        usage: null,
      },
      isLoading: false,
    };
  };

  it('warns when the domain has more than one DMARC record', () => {
    withDmarcRecord({
      state: 'multiple',
      found: ['v=DMARC1; p=none', 'v=DMARC1; p=reject'],
      policy: null,
      reportsToWeldSuite: false,
    });
    render(<MailDomainsSettingsPage />);
    const row = screen.getByTestId('mail-domain-acme.nl');
    expect(within(row).getByText(td.dmarcRecord.multiple)).toBeInTheDocument();
    expect(within(row).getByText(td.dmarcRecord.neverSecond)).toBeInTheDocument();
  });

  it('flags an unusable record, and a record that lacks the WeldSuite address', () => {
    withDmarcRecord({
      state: 'invalid',
      found: ['junk'],
      policy: null,
      reportsToWeldSuite: false,
    });
    const { unmount } = render(<MailDomainsSettingsPage />);
    expect(screen.getByText(td.dmarcRecord.invalid)).toBeInTheDocument();
    unmount();

    withDmarcRecord({
      state: 'ok',
      found: ['v=DMARC1; p=none'],
      policy: null,
      reportsToWeldSuite: false,
    });
    render(<MailDomainsSettingsPage />);
    expect(screen.getByText(td.dmarcRecord.notReporting)).toBeInTheDocument();
    expect(screen.queryByText(td.dmarcRecord.multiple)).not.toBeInTheDocument();
  });

  it('hides the panel when the feature is unavailable', () => {
    verifiedSettings();
    state.dmarcAvailable = false;
    render(<MailDomainsSettingsPage />);
    expect(screen.queryByTestId('dmarc-panel-acme.nl')).not.toBeInTheDocument();
  });

  it('offers the panel for a verified domain only', () => {
    const { unmount } = render(<MailDomainsSettingsPage />);
    expect(screen.queryByTestId('dmarc-panel-acme.nl')).not.toBeInTheDocument();
    unmount();
    verifiedSettings();
    render(<MailDomainsSettingsPage />);
    expect(screen.getByTestId('dmarc-panel-acme.nl')).toBeInTheDocument();
  });

  it('lists the blockers as sentences, with permille as percent', () => {
    verifiedSettings();
    withSummary(
      summary({
        advice: {
          current: 'none',
          next: 'quarantine',
          ready: false,
          suggestedRecord: null,
          blockers: [
            { code: 'passRate', permille: 912, need: 980 },
            { code: 'tooFewDays', have: 5, need: 14 },
            {
              code: 'failingSource',
              key: 'name:crm.example',
              name: 'crm.example',
              sharePermille: 250,
              passPermille: 100,
            },
          ],
        },
      }),
    );
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    expect(
      screen.getByText('Only 91.2% of the mail passes DMARC; at least 98.0% is needed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The reports cover 5 of the 14 days that are needed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/crm\.example sends 25\.0% of the mail but only 10\.0%/),
    ).toBeInTheDocument();
    expect(screen.getByText(td.dmarc.spfNote)).toBeInTheDocument();
  });

  it('shows the suggested record when ready, and the empty state without reports', () => {
    verifiedSettings();
    const record = 'v=DMARC1; p=quarantine; rua=mailto:r-abc@dmarc.weldsuite.eu';
    withSummary(
      summary({
        advice: {
          current: 'none',
          next: 'quarantine',
          ready: true,
          suggestedRecord: record,
          blockers: [],
        },
      }),
    );
    const { unmount } = render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    expect(screen.getByText('Ready to move to quarantine')).toBeInTheDocument();
    expect(screen.getByText(record)).toBeInTheDocument();
    unmount();

    withSummary(
      summary({
        totals: {
          ...summary().totals,
          reports: 0,
          messages: 0,
          passed: 0,
          lastReportAt: null,
        },
      }),
    );
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    expect(screen.getByText(td.dmarc.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(/r-abc@dmarc\.weldsuite\.eu/)).toBeInTheDocument();
  });

  it('names every other blocker', () => {
    verifiedSettings();
    withSummary(
      summary({
        advice: {
          current: 'quarantine',
          next: 'reject',
          ready: false,
          suggestedRecord: null,
          blockers: [
            { code: 'recordProblem', state: 'multiple' },
            { code: 'noReports' },
            { code: 'tooFewReporters', have: 1, need: 2 },
            { code: 'weldsuiteFailing', permille: 950, need: 995 },
            { code: 'tooSoon', days: 12, need: 30 },
          ],
        },
      }),
    );
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    expect(
      screen.getByText('Your DMARC record is present more than once. Fix that first.'),
    ).toBeInTheDocument();
    expect(screen.getByText(td.dmarc.advice.blockers.noReports)).toBeInTheDocument();
    expect(
      screen.getByText('Reports came from 1 receivers; at least 2 are needed.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Only 95.0% of the mail sent through WeldSuite passes DMARC; at least 99.5% is needed.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Wait a little longer: 12 of the 30 days that are needed have passed.'),
    ).toBeInTheDocument();
  });

  it('lists the failing mail and the reporting receivers', () => {
    verifiedSettings();
    withSummary(
      summary({
        failures: [
          {
            sourceKey: 'ip:203.0.113.9',
            sourceName: '203.0.113.9',
            headerFrom: 'news.acme.nl',
            dkimAligned: false,
            spfAligned: false,
            dkimDomains: ['spoof.example'],
            spfDomain: 'bounce.spoof.example',
            messages: 3,
          },
        ],
        reporters: [{ domain: 'google.com', org: 'google.com', reports: 4, messages: 200 }],
      }),
    );
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    expect(screen.getByText(td.dmarc.failures.title)).toBeInTheDocument();
    expect(screen.getByText('news.acme.nl')).toBeInTheDocument();
    expect(screen.getByText('DKIM: spoof.example')).toBeInTheDocument();
    expect(screen.getByText('SPF: bounce.spoof.example')).toBeInTheDocument();
    expect(screen.getByText(td.dmarc.reporters.title)).toBeInTheDocument();
    expect(screen.getAllByText('google.com').length).toBeGreaterThan(0);
  });

  it('copies the suggested record', async () => {
    verifiedSettings();
    const record = 'v=DMARC1; p=reject';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    withSummary(
      summary({
        advice: {
          current: 'quarantine',
          next: 'reject',
          ready: true,
          suggestedRecord: record,
          blockers: [],
        },
      }),
    );
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    fireEvent.click(screen.getByRole('button', { name: td.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(record));
    expect(state.toast.success).toHaveBeenCalled();
  });

  it('clears a not-mine mark, and says when a mark fails', async () => {
    verifiedSettings();
    const source = {
      key: 'name:crm.example',
      kind: 'name' as const,
      name: 'crm.example',
      ips: ['203.0.113.9'],
      messages: 50,
      passed: 5,
      dkimAligned: 5,
      spfAligned: 0,
      mark: 'not_mine' as const,
    };
    withSummary(summary({ sources: [source] }));
    state.mark.mockResolvedValueOnce({ data: { key: source.key, mark: null } });
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.sources.notMine }));
    await waitFor(() =>
      expect(state.mark).toHaveBeenCalledWith({ key: source.key, mark: null }),
    );
    await waitFor(() =>
      expect(state.toast.success).toHaveBeenCalledWith(td.dmarc.sources.markCleared),
    );

    state.mark.mockRejectedValueOnce(new Error('403'));
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.sources.mine }));
    await waitFor(() =>
      expect(state.toast.error).toHaveBeenCalledWith(td.dmarc.sources.markFailed),
    );
  });

  it('marks a source as mine', async () => {
    verifiedSettings();
    state.mark.mockResolvedValue({
      data: { key: 'name:crm.example', mark: 'mine' },
    });
    withSummary(
      summary({
        sources: [
          {
            key: 'name:crm.example',
            kind: 'name',
            name: 'crm.example',
            ips: ['203.0.113.9'],
            messages: 50,
            passed: 5,
            dkimAligned: 5,
            spfAligned: 0,
            mark: null,
          },
        ],
      }),
    );
    render(<MailDomainsSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.title }));
    fireEvent.click(screen.getByRole('button', { name: td.dmarc.sources.mine }));
    await waitFor(() =>
      expect(state.mark).toHaveBeenCalledWith({
        key: 'name:crm.example',
        mark: 'mine',
      }),
    );
  });
});
