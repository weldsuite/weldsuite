import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (key: string) => perms.granted.has(key) }) }));
const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: download }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { TinMatchingPanel } from './tin-matching-panel';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <TinMatchingPanel />
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
  api.patch.mockReset();
  download.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  perms.granted = new Set(['taxes:file', 'tax_ids:reveal', 'invoices:update']);
});

afterEach(cleanup);

describe('TIN matching: the upload file', () => {
  it('asks first, because the file holds full TINs, then lists the files and who was left out', async () => {
    api.get.mockResolvedValue({
      data: {
        files: [{ filename: 'tin-matching-001.txt', content: '1,123456789,ACME', recordCount: 3 }],
        recordCount: 3,
        skipped: [{ partyId: 'p9', reason: 'itin_not_supported', name: 'Jo Itin' }],
      },
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Create TIN matching file' }));
    expect(await screen.findByText('Create the TIN matching file?')).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create file' }));

    const result = await screen.findByTestId('tin-file-result');
    expect(api.get).toHaveBeenCalledWith('/form-1099/tin-matching/file');
    expect(within(result).getByText('File ready: 3 vendors')).toBeTruthy();
    expect(within(result).getByText('Jo Itin: The service does not match ITINs')).toBeTruthy();

    await user.click(within(result).getByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![1]).toBe('tin-matching-001.txt');

    await user.click(within(result).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('tin-file-result')).toBeNull();
  });

  it('can include the vendors that were matched already', async () => {
    api.get.mockResolvedValue({ data: { files: [], recordCount: 0, skipped: [] } });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByLabelText('Include vendors the IRS already matched'));
    await user.click(screen.getByRole('button', { name: 'Create TIN matching file' }));
    await user.click(await screen.findByRole('button', { name: 'Create file' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/form-1099/tin-matching/file?all=true'));
    expect(await screen.findByText('No vendor with a TIN needs matching.')).toBeTruthy();
  });

  it('is not offered without the permission to file taxes and to reveal tax IDs', () => {
    perms.granted = new Set(['taxes:file']);
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Create TIN matching file' })).toBeNull();
    expect(screen.getByText('Creating the file needs permission to file taxes and to reveal tax IDs.')).toBeTruthy();
  });
});

describe('TIN matching: the results', () => {
  const summary = {
    updated: ['p1', 'p2', 'p3'],
    byStatus: { match: 1, mismatch: 1, not_issued: 1 },
    problems: [
      { partyId: 'p2', name: 'Mismatch LLC', status: 'mismatch', backupWithholding: false, suggestion: 'Send a first B notice' },
      { partyId: 'p3', name: 'Ghost Inc', status: 'not_issued', backupWithholding: true, suggestion: 'Backup withholding is already on.' },
    ],
    stale: [{ partyId: 'p4', name: 'Changed Co' }],
    unknownAccounts: [{ line: 7, accountNumber: 'zzz' }],
    ignored: [],
    unreadable: [{ line: 9, text: '???' }],
  };

  it('sends the pasted results, then shows what matched, what did not, and what to do about it', async () => {
    api.post.mockResolvedValue({ data: summary });
    const user = userEvent.setup();
    renderPanel();
    expect((screen.getByRole('button', { name: 'Apply results' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Results from the IRS'), { target: { value: '0,123456789,ACME,wf_p1' } });
    await user.click(screen.getByRole('button', { name: 'Apply results' }));

    const results = await screen.findByTestId('tin-results');
    expect(api.post).toHaveBeenCalledWith('/form-1099/tin-matching/results', { text: '0,123456789,ACME,wf_p1' });
    expect(within(results).getByText('3 vendors updated')).toBeTruthy();
    expect(within(results).getByText('IRS match: 1')).toBeTruthy();

    const problems = within(results).getByTestId('tin-problems');
    expect(within(problems).getByText('2 vendors the IRS could not match')).toBeTruthy();
    expect(within(problems).getByText('Mismatch LLC')).toBeTruthy();
    // Backup withholding is offered where it is not on yet.
    expect(within(problems).getAllByRole('button', { name: 'Turn on backup withholding' })).toHaveLength(1);
    expect(within(problems).getByText('Backup withholding is already on.')).toBeTruthy();
    expect(within(results).getByText(/Not applied, the TIN changed after the file went out: Changed Co/)).toBeTruthy();
    expect(within(results).getByText('1 lines of the results could not be read.')).toBeTruthy();
    // The pasted text is cleared once applied.
    expect((screen.getByLabelText('Results from the IRS') as HTMLTextAreaElement).value).toBe('');
  });

  it('reads a results file the user chose', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: { ...summary, problems: [], stale: [], unknownAccounts: [], unreadable: [] } });
    renderPanel();
    const file = new File(['0,123456789,ACME,wf_p1\n'], 'results.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Choose results file', { selector: 'input' }), { target: { files: [file] } });
    await waitFor(() => expect((screen.getByLabelText('Results from the IRS') as HTMLTextAreaElement).value).toBe('0,123456789,ACME,wf_p1\n'));
    await user.click(screen.getByRole('button', { name: 'Apply results' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/form-1099/tin-matching/results', { text: '0,123456789,ACME,wf_p1\n' }));
  });

  it('says so when the results could not be applied', async () => {
    api.post.mockRejectedValue(new Error('Invalid request body'));
    const user = userEvent.setup();
    renderPanel();
    fireEvent.change(screen.getByLabelText('Results from the IRS'), { target: { value: 'junk' } });
    await user.click(screen.getByRole('button', { name: 'Apply results' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The results could not be applied', { description: 'Invalid request body' }));
  });

  it('needs the permission to file taxes', () => {
    perms.granted = new Set();
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Apply results' })).toBeNull();
    expect(screen.getByText('Applying results needs permission to file taxes.')).toBeTruthy();
  });
});
