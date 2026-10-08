import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (v: number) => String(v), formatDate: (v: string) => v, today: () => '2027-01-20' }),
}));
const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: download }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { IrisDialog, firstCsvLine } from './iris-dialog';
import { MarkFiledDialog } from './mark-filed-dialog';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

const irisResult = {
  data: {
    taxYear: 2026,
    formType: 'nec',
    correctionsOnly: false,
    files: [
      { filename: '1099-NEC-2026-001.csv', content: 'a,b\n1,2\n', recordCount: 100, warnings: [] },
      { filename: '1099-NEC-2026-002.csv', content: 'a,b\n3,4\n', recordCount: 7, warnings: ['Recipient X: name truncated to 40 characters'] },
    ],
  },
};

/** jsdom's Blob has no text(); the browsers the page runs in do. */
beforeAll(() => {
  if (typeof Blob.prototype.text !== 'function') {
    Blob.prototype.text = function text(this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  download.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

afterEach(cleanup);

describe('firstCsvLine', () => {
  it('reads the header row of the IRIS template, without a byte order mark', () => {
    expect(firstCsvLine('﻿TaxYear,FormType,"Recipient, Name"\r\n2026,NEC,x')).toBe('TaxYear,FormType,"Recipient, Name"');
    expect(firstCsvLine('A,B\nC,D')).toBe('A,B');
    expect(firstCsvLine('')).toBe('');
  });
});

describe('IrisDialog', () => {
  it('creates the files with the built-in layout, lists them with their record counts and warnings, and saves each as CSV', async () => {
    api.get.mockResolvedValue(irisResult);
    const user = userEvent.setup();
    wrap(<IrisDialog filingId="f1" formLabel="1099-NEC" open onOpenChange={vi.fn()} />);
    expect(screen.getByText('The built-in column layout is used.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create files' }));

    expect(await screen.findByTestId('iris-result')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/form-1099/filings/f1/iris-csv');
    expect(screen.getByText('107 recipients in the files below.')).toBeTruthy();
    expect(screen.getByText('1099-NEC-2026-001.csv')).toBeTruthy();
    expect(screen.getByText('Recipient X: name truncated to 40 characters')).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Download' })[1]!);
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0]!;
    expect(filename).toBe('1099-NEC-2026-002.csv');
    expect((blob as Blob).type).toMatch(/^text\/csv/);
    expect(await (blob as Blob).text()).toBe('a,b\n3,4\n');
  });

  it('sends the header row of a chosen template with the request', async () => {
    api.post.mockResolvedValue(irisResult);
    const user = userEvent.setup();
    wrap(<IrisDialog filingId="f1" formLabel="1099-NEC" open onOpenChange={vi.fn()} />);
    const template = new File(['TaxYear,FormType,Name\n2026,NEC,Example\n'], 'iris-template.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose template file', { selector: 'input' }), { target: { files: [template] } });
    expect(await screen.findByTestId('iris-template-name')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create files' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/form-1099/filings/f1/iris-csv', { templateHeaders: 'TaxYear,FormType,Name' }));
    expect(api.get).not.toHaveBeenCalled();
  });

  it('says so when the files could not be created, for example a payer without a TIN', async () => {
    api.get.mockRejectedValue(new Error('The payer details are incomplete'));
    const user = userEvent.setup();
    wrap(<IrisDialog filingId="f1" formLabel="1099-NEC" open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create files' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('The IRIS files could not be created', { description: 'The payer details are incomplete' }),
    );
    expect(screen.queryByTestId('iris-result')).toBeNull();
  });

  it('drops the files, which hold full TINs, when the dialog closes', async () => {
    api.get.mockResolvedValue(irisResult);
    const user = userEvent.setup();
    const view = wrap(<IrisDialog filingId="f1" formLabel="1099-NEC" open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create files' }));
    await screen.findByTestId('iris-result');
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLanguage="en">
          <IrisDialog filingId="f1" formLabel="1099-NEC" open={false} onOpenChange={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLanguage="en">
          <IrisDialog filingId="f1" formLabel="1099-NEC" open onOpenChange={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('iris-result')).toBeNull();
  });
});

describe('MarkFiledDialog', () => {
  it('needs the confirmation number', async () => {
    const user = userEvent.setup();
    wrap(<MarkFiledDialog filingId="f1" formLabel="1099-NEC" correction={false} open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));
    expect(await screen.findByText('Enter the confirmation number.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends the confirmation number and the date, which starts on today', async () => {
    api.post.mockResolvedValue({ data: { filing: { id: 'f1', status: 'filed' }, lines: [] } });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    wrap(<MarkFiledDialog filingId="f1" formLabel="1099-NEC" correction={false} open onOpenChange={onOpenChange} />);
    expect((screen.getByLabelText('Filed on') as HTMLInputElement).value).toBe('2027-01-20');
    await user.type(screen.getByLabelText(/IRS confirmation number/), '  IRIS-123456 ');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/form-1099/filings/f1/mark-filed', { confirmationNumber: 'IRIS-123456', filedAt: '2027-01-20' }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('names the corrections when the filing is a correction run', () => {
    wrap(<MarkFiledDialog filingId="f1" formLabel="1099-NEC" correction open onOpenChange={vi.fn()} />);
    expect(screen.getByText('Mark the 1099-NEC corrections as filed')).toBeTruthy();
  });
});
