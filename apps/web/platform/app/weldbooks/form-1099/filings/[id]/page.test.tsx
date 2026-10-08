import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Form1099Filing, Form1099FilingLine, Form1099FilingStatus } from '@/lib/api/domains/weldbooks-1099';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search: _search, children, ...rest }: { to: string; params?: Record<string, string>; search?: unknown; children: React.ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ id: 'f1' }),
  useNavigate: () => navigate,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (key: string) => perms.granted.has(key) }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (v: number | string) => `$${Number(v).toFixed(2)}`, formatDate: (v: string) => `on ${v}`, today: () => '2027-01-20' }),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import Form1099FilingPage from './page';

function filing(status: Form1099FilingStatus, overrides: Partial<Form1099Filing> = {}): Form1099Filing {
  return {
    id: 'f1',
    entityId: 'e1',
    taxYear: 2026,
    formType: 'nec',
    status,
    generatedAt: null,
    filedAt: null,
    confirmationNumber: null,
    notes: null,
    createdAt: '2027-01-02T00:00:00.000Z',
    updatedAt: '2027-01-02T00:00:00.000Z',
    lineCount: 2,
    totals: { amount: 3500, withheld: 0 },
    statusCounts: {},
    ...overrides,
  };
}

function line(id: string, overrides: Partial<Form1099FilingLine> = {}): Form1099FilingLine {
  return {
    id,
    filingId: 'f1',
    partyId: `party_${id}`,
    partyName: `Vendor ${id}`,
    recipient: { name: `Vendor ${id} LLC`, tinType: 'ein', tinLast4: '6789' },
    hasTin: true,
    boxes: { nec_1: 2500 },
    adjustments: null,
    federalWithheld: '0.00',
    stateCode: null,
    stateIdNumber: null,
    stateIncome: null,
    stateWithheld: null,
    status: 'included',
    excludedReason: null,
    isCorrected: false,
    correctionOfLineId: null,
    deliveryMethod: null,
    deliveredAt: null,
    superseded: false,
    pendingCorrection: false,
    stateHint: null,
    ...overrides,
  };
}

function load(status: Form1099FilingStatus, lines: Form1099FilingLine[] = [line('a'), line('b', { boxes: { nec_1: 1000 } })], overrides: Partial<Form1099Filing> = {}) {
  api.get.mockResolvedValue({ data: { filing: filing(status, overrides), lines } });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <Form1099FilingPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.warning.mockReset();
  perms.granted = new Set(['taxes:read', 'taxes:update', 'taxes:file', 'taxes:delete', 'tax_ids:reveal']);
});

afterEach(cleanup);

const actions = () => within(screen.getByTestId('filing-actions'));

describe('1099 filing page', () => {
  it('shows what the filing is and what to do next', async () => {
    load('draft');
    renderPage();
    expect(await screen.findByRole('heading', { name: '1099-NEC · 2026' })).toBeTruthy();
    expect(screen.getByTestId('filing-recipients').textContent).toBe('2');
    expect(screen.getByTestId('filing-total').textContent).toBe('$3500.00');
    expect(screen.getByTestId('next-step').textContent).toMatch(/mark the filing as reviewed/);
    expect(screen.getByText('Vendor a LLC')).toBeTruthy();
    expect(screen.getAllByText('**-***6789')).toHaveLength(2);
    expect(screen.getAllByText('On the form')).toHaveLength(2);
  });

  it('says so when the filing is not found, or could not be loaded', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    renderPage();
    expect(await screen.findByText('This filing does not exist.')).toBeTruthy();
    cleanup();
    api.get.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText('The filing could not be loaded.')).toBeTruthy();
  });

  it('a draft can be refreshed, reviewed or deleted, but has no outputs yet', async () => {
    load('draft');
    renderPage();
    await screen.findByRole('heading', { name: '1099-NEC · 2026' });
    expect(actions().getByRole('button', { name: 'Refresh from the books' })).toBeTruthy();
    expect(actions().getByRole('button', { name: 'Mark as reviewed' })).toBeTruthy();
    expect(actions().getByRole('button', { name: 'Delete draft' })).toBeTruthy();
    expect(actions().queryByRole('button', { name: 'IRIS upload file' })).toBeNull();
    expect(actions().queryByRole('button', { name: 'Download copies' })).toBeNull();
    expect(actions().queryByRole('button', { name: 'Generate' })).toBeNull();
  });

  it('marks a draft as reviewed', async () => {
    load('draft');
    api.post.mockResolvedValue({ data: { filing: filing('reviewed'), lines: [line('a'), line('b')], unresolved: [] } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Mark as reviewed' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/form-1099/filings/f1/review'));
    expect(await screen.findByRole('button', { name: 'Generate' })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Marked as reviewed');
  });

  it('asks before generating, then generates', async () => {
    load('reviewed');
    api.post.mockResolvedValue({ data: { filing: filing('generated'), lines: [line('a'), line('b')] } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Generate this filing?')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    // The dialog is modal: the page behind it is hidden from the accessibility tree, so this is the dialog's button.
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/form-1099/filings/f1/generate'));
  });

  it('lists the recipients that still need a TIN or address with a link to fix them', async () => {
    load('reviewed', [line('a'), line('b', { status: 'needs_tin', hasTin: false, recipient: { name: 'Vendor b LLC' } })]);
    renderPage();
    const alert = await screen.findByTestId('filing-blockers');
    expect(within(alert).getByText('1 recipients cannot be filed yet')).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Vendor b LLC' }).getAttribute('href')).toBe('/weldbooks/customers/party_b/edit');
  });

  it('shows the server\'s list of blocking recipients when generating is refused', async () => {
    load('reviewed');
    api.post.mockRejectedValue(
      Object.assign(new Error('1 recipient(s) still need a TIN or an address.'), {
        body: { error: { details: { lines: [{ lineId: 'x', partyId: 'party_x', name: 'Vendor X', status: 'needs_address' }] } } },
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Generate' }));
    await screen.findByText('Generate this filing?');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    const alert = await screen.findByTestId('filing-blockers');
    expect(within(alert).getByRole('link', { name: 'Vendor X' })).toBeTruthy();
    expect(within(alert).getByText('(needs an address)')).toBeTruthy();
  });

  it('a generated filing offers the IRIS file, the copies and marking it filed', async () => {
    load('generated');
    renderPage();
    await screen.findByRole('heading', { name: '1099-NEC · 2026' });
    expect(actions().getByRole('button', { name: 'IRIS upload file' })).toBeTruthy();
    expect(actions().getByRole('button', { name: 'Download copies' })).toBeTruthy();
    expect(actions().getByRole('button', { name: 'Mark as filed' })).toBeTruthy();
    expect(actions().queryByRole('button', { name: 'Mark as reviewed' })).toBeNull();
    expect(actions().queryByRole('button', { name: 'Delete draft' })).toBeNull();
    expect(screen.getAllByText('Not delivered')).toHaveLength(2);
  });

  it('keeps the IRIS file from people who may not reveal tax IDs, and says why', async () => {
    perms.granted = new Set(['taxes:read', 'taxes:update', 'taxes:file']);
    load('generated');
    renderPage();
    await screen.findByRole('heading', { name: '1099-NEC · 2026' });
    expect(actions().queryByRole('button', { name: 'IRIS upload file' })).toBeNull();
    expect(screen.getByText('Creating the IRIS file needs permission to file taxes and to reveal tax IDs.')).toBeTruthy();
  });

  it('shows a read-only filing to someone who can only view taxes', async () => {
    perms.granted = new Set(['taxes:read']);
    load('draft');
    renderPage();
    await screen.findByRole('heading', { name: '1099-NEC · 2026' });
    expect(actions().queryByRole('button')).toBeNull();
    expect((screen.getByLabelText('Notes') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('a filed filing can correct a recipient and shows when each copy was delivered', async () => {
    load(
      'filed',
      [line('a', { status: 'filed', deliveryMethod: 'print', deliveredAt: '2027-01-25T00:00:00.000Z' }), line('b', { status: 'filed' })],
      { filedAt: '2027-01-28T00:00:00.000Z', confirmationNumber: 'IRIS-99' },
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: '1099-NEC · 2026' });
    expect(screen.getByText('IRIS-99')).toBeTruthy();
    expect(screen.getByText('Delivered on paper on on 2027-01-25T00:00:00.000Z')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Actions for Vendor a LLC' }));
    expect(await screen.findByRole('menuitem', { name: 'Correct' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy B (recipient)' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delivered electronically' })).toBeTruthy();
    // Nothing on a filed filing can be edited in place.
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  });

  it('records a delivery from the row menu', async () => {
    load('generated');
    api.post.mockResolvedValue({ data: { filing: filing('generated'), lines: [line('a'), line('b')], deliveredAt: '2027-01-21T00:00:00.000Z', deliveryMethod: 'print' } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Actions for Vendor a LLC' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delivered on paper' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/form-1099/filings/f1/lines/a/delivered', { method: 'print' }));
  });

  it('shows pending corrections only to be edited and filed, and marks them filed', async () => {
    load('corrected', [
      line('a', { status: 'filed', superseded: true }),
      line('a2', { isCorrected: true, correctionOfLineId: 'a', pendingCorrection: true, boxes: { nec_1: 2400 } }),
    ]);
    renderPage();
    await screen.findByRole('heading', { name: '1099-NEC · 2026' });
    expect(actions().getByRole('button', { name: 'IRIS file for the corrections' })).toBeTruthy();
    expect(actions().getByRole('button', { name: 'Mark corrections as filed' })).toBeTruthy();
    expect(screen.getByText('Correction')).toBeTruthy();
    expect(screen.getByText('Replaced')).toBeTruthy();
  });
});
