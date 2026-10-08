import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'prn_1' }),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/weldbooks/payment-runs/prn_1/checks' } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: 'US', isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
const files = vi.hoisted(() => ({ download: vi.fn(), print: vi.fn() }));
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: files.download }));
vi.mock('@/lib/weldbooks/print-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/weldbooks/print-pdf')>()),
  printPdfBytes: files.print,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import PrintChecksPage from './page';
import { installPointerPolyfills, makeCheck, makePrintData, renderWithProviders } from '../../test-utils';

const run = { id: 'prn_1', bankAccountName: 'Operating', paymentDate: '2026-10-09', status: 'approved', method: 'check' };

function routes(printData: ReturnType<typeof makePrintData>) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/payment-runs/prn_1/checks')) return { data: printData };
    if (path === '/payment-runs/prn_1') return { data: run };
    return { data: [] };
  });
  api.post.mockResolvedValue({ data: { run, printed: ['pay_001001', 'pay_001002'], alreadyPrinted: [] } });
}

const twoChecks = () => [makeCheck('001001', 'Acme Supplies', '100.00'), makeCheck('001002', 'Brightline LLC', '250.50')];

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(files)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:manage', 'bills:read']);
});

describe('PrintChecksPage', () => {
  it('tells the person the MICR line is not printed when the account prints on blank stock', async () => {
    routes(makePrintData(twoChecks(), { printMicr: true }));
    renderWithProviders(<PrintChecksPage />);

    expect(await screen.findByText('The MICR line is not printed yet')).toBeInTheDocument();
    expect(screen.getByText(/needs a MICR \(E-13B\) font/)).toBeInTheDocument();
    expect(screen.getByText(/Don't deposit a check without its MICR line/)).toBeInTheDocument();
    expect(screen.getByText(/Blank stock: the whole check is printed, except the MICR line/)).toBeInTheDocument();
  });

  it('has no MICR notice for preprinted stock', async () => {
    routes(makePrintData(twoChecks(), { printMicr: false }));
    renderWithProviders(<PrintChecksPage />);

    expect(await screen.findByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.queryByText('The MICR line is not printed yet')).not.toBeInTheDocument();
    expect(screen.getByText(/Preprinted stock: only the date, payee, amount, memo and the stubs are printed/)).toBeInTheDocument();
    expect(screen.getByText(/the first check is number 001001/)).toBeInTheDocument();
  });

  it('selects the checks still to print, and leaves the printed ones for a reprint', async () => {
    routes(makePrintData([...twoChecks(), makeCheck('001003', 'Printed Co', '5.00', { checkStatus: 'printed' })]));
    renderWithProviders(<PrintChecksPage />);

    await screen.findByText('Acme Supplies');
    expect(screen.getByRole('checkbox', { name: 'Select check 001001' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select check 001002' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select check 001003' })).not.toBeChecked();
  });

  it('only marks checks printed after a download or print, and only the ones still to print', async () => {
    routes(makePrintData(twoChecks()));
    const user = userEvent.setup();
    renderWithProviders(<PrintChecksPage />);
    await screen.findByText('Acme Supplies');

    const mark = screen.getByRole('button', { name: 'Mark as printed (2)' });
    expect(mark).toBeDisabled();
    expect(screen.getByText('Download or print the PDF first.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(files.download).toHaveBeenCalledTimes(1));
    expect(files.download.mock.calls[0]?.[1]).toBe('checks-2026-10-09.pdf');
    await waitFor(() => expect(mark).toBeEnabled());

    await user.click(mark);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Did the checks print correctly?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Mark as printed' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/checks/printed', { paymentIds: ['pay_001001', 'pay_001002'] }),
    );
  });

  it('prints only the selected checks', async () => {
    routes(makePrintData(twoChecks()));
    const user = userEvent.setup();
    renderWithProviders(<PrintChecksPage />);
    await screen.findByText('Acme Supplies');

    await user.click(screen.getByRole('checkbox', { name: 'Select check 001002' }));
    expect(screen.getByRole('button', { name: 'Mark as printed (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(files.print).toHaveBeenCalledTimes(1));
    // A one-check selection is a one-page PDF.
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.load(files.print.mock.calls[0]?.[0] as Uint8Array);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('shows a check at its net amount, with the gross and the backup withholding under it', async () => {
    routes(
      makePrintData([
        makeCheck('001001', 'Oscar Consulting', '2280.00', { grossAmount: '3000.00', backupWithholdingAmount: '720.00' }),
        makeCheck('001002', 'Plain Co', '100.00'),
      ]),
    );
    renderWithProviders(<PrintChecksPage />);

    expect(await screen.findByText('Oscar Consulting')).toBeInTheDocument();
    expect(screen.getByText('$2280.00')).toBeInTheDocument();
    expect(screen.getByText('Gross $3000.00, withheld $720.00')).toBeInTheDocument();
    expect(screen.queryByText(/Gross \$100\.00/)).not.toBeInTheDocument();
  });

  it('lets a printed check be voided from here', async () => {
    routes(makePrintData(twoChecks()));
    const user = userEvent.setup();
    renderWithProviders(<PrintChecksPage />);
    await screen.findByText('Acme Supplies');

    await user.click(screen.getAllByRole('button', { name: 'Void' })[0]!);
    expect(await screen.findByText('Void check 001001')).toBeInTheDocument();
  });

  it('asks for permission instead of loading the checks', async () => {
    permissions.allowed = new Set(['banking:read']);
    routes(makePrintData(twoChecks()));
    renderWithProviders(<PrintChecksPage />);

    expect(await screen.findByText(/need permission to manage banking/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows the server error when the checks cannot be printed yet', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/payment-runs/prn_1/checks')) {
        throw Object.assign(new Error('Checks can be printed once the run is approved.'), { status: 409, code: 'RUN_NOT_APPROVED', body: {} });
      }
      return { data: run };
    });
    renderWithProviders(<PrintChecksPage />);
    expect(await screen.findByText('This can be done once the run is approved.')).toBeInTheDocument();
  });
});
