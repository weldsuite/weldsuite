import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentSettings } from '@weldsuite/app-api-client/schemas/replenishment';

const env = vi.hoisted(() => ({
  createImport: vi.fn(),
  addRows: vi.fn(),
  completeImport: vi.fn(),
  deleteImport: vi.fn(),
  updateSettings: vi.fn(),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useCreateSalesHistoryImport: () => ({ mutateAsync: env.createImport, isPending: false }),
  useAddSalesHistoryRows: () => ({ mutateAsync: env.addRows, isPending: false }),
  useCompleteSalesHistoryImport: () => ({ mutateAsync: env.completeImport, isPending: false }),
  useDeleteSalesHistoryImport: () => ({ mutateAsync: env.deleteImport, isPending: false }),
  useUpdateReplenishmentSettings: () => ({ mutateAsync: env.updateSettings, isPending: false }),
}));

import { ImportWizard } from './import-wizard';

const settings = { historyCutoverDate: null } as unknown as ReplenishmentSettings;

beforeEach(() => {
  for (const fn of Object.values(env)) fn.mockReset();
  env.addRows.mockResolvedValue({ imported: 1, skipped: 0, unmatchedSkus: [] });
  env.deleteImport.mockResolvedValue(undefined);
});

describe('ImportWizard', () => {
  it('stops an upload when the wizard closes, and deletes the import created after it closed', async () => {
    let resolveCreate: (value: { id: string }) => void = () => undefined;
    env.createImport.mockReturnValue(new Promise((resolve) => (resolveCreate = resolve)));
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);

    const csv = 'date,sku,quantity\n2026-01-05,W-1,3\n';
    const file = new File([csv], 'sales.csv', { type: 'text/csv' });
    // jsdom's File has no text().
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    await user.upload(screen.getByLabelText('Choose a CSV file'), file);
    await user.click(await screen.findByRole('button', { name: 'Upload 1 rows' }));
    expect(env.createImport).toHaveBeenCalledWith('sales.csv');

    // Closed while the import is still being created: there is no import id to delete yet.
    await user.keyboard('{Escape}');
    resolveCreate({ id: 'imp_1' });

    await waitFor(() => expect(env.deleteImport).toHaveBeenCalledWith('imp_1'));
    expect(env.addRows).not.toHaveBeenCalled();
  });
});

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const GOOD_CSV = 'date,sku,quantity,warehouse\n2026-01-05,W-1,3,MAIN\n2026-01-06,W-2,4,\nnot-a-date,W-3,1,\n';

async function chooseFile(user: ReturnType<typeof userEvent.setup>, csv: string, name = 'sales.csv') {
  const file = new File([csv], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
  await user.upload(screen.getByLabelText('Choose a CSV file'), file);
}

async function uploadToReview(user: ReturnType<typeof userEvent.setup>, result: { imported: number; skipped: number; unmatchedSkus: string[] }) {
  env.createImport.mockResolvedValue({ id: 'imp_1' });
  env.addRows.mockResolvedValue(result);
  await chooseFile(user, GOOD_CSV);
  await user.click(await screen.findByRole('button', { name: 'Upload 2 rows' }));
}

describe('ImportWizard steps', () => {
  it('maps the columns, previews the rows and lists the rows it cannot read', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await chooseFile(user, GOOD_CSV);
    expect(await screen.findByText('sales.csv: 3 rows')).toBeInTheDocument();
    expect(screen.getByText(/2 rows are ready, 2 different SKUs/)).toBeInTheDocument();
    expect(screen.getByText('2026-01-05 · W-1 · 3 · MAIN')).toBeInTheDocument();
    expect(screen.getByText('1 rows cannot be read and are left out')).toBeInTheDocument();
    expect(screen.getByText(/Line 4: not a date: "not-a-date"/)).toBeInTheDocument();
  });

  it('re-reads the file with another date format and another column', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await chooseFile(user, 'date,sku,quantity,alt\n05/01/2026,W-1,3,9\n');
    expect(await screen.findByText('2026-01-05 · W-1 · 3')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Date format' }));
    await user.click(await screen.findByRole('option', { name: 'Month-day-year' }));
    expect(screen.getByText('2026-05-01 · W-1 · 3')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Quantity' }));
    await user.click(await screen.findByRole('option', { name: 'alt' }));
    expect(screen.getByText('2026-05-01 · W-1 · 9')).toBeInTheDocument();
  });

  it('asks for the columns that were not found and enables the upload once the mapping is complete', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await chooseFile(user, 'when,what,amount,note\n2026-01-05,W-1,3,x\n');
    expect(await screen.findByRole('button', { name: 'Upload 0 rows' })).toBeDisabled();
    expect(screen.queryByText(/rows are ready/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Date' }));
    await user.click(await screen.findByRole('option', { name: 'when' }));
    await user.click(screen.getByRole('combobox', { name: 'SKU' }));
    await user.click(await screen.findByRole('option', { name: 'what' }));
    await user.click(screen.getByRole('combobox', { name: 'Quantity' }));
    await user.click(await screen.findByRole('option', { name: 'amount' }));
    expect(screen.getByRole('button', { name: 'Upload 1 rows' })).toBeEnabled();
    // An optional column can be taken out of the mapping again.
    await user.click(screen.getByRole('combobox', { name: 'Reference' }));
    await user.click(await screen.findByRole('option', { name: 'note' }));
    await user.click(screen.getByRole('combobox', { name: 'Reference' }));
    await user.click(await screen.findByRole('option', { name: 'Not in the file' }));
    expect(screen.getByRole('button', { name: 'Upload 1 rows' })).toBeEnabled();
  });

  it('goes back to the file step from the mapping', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await chooseFile(user, GOOD_CSV);
    await user.click(await screen.findByRole('button', { name: 'Choose another file' }));
    expect(screen.getByLabelText('Choose a CSV file')).toBeInTheDocument();
  });

  it('refuses an empty file and a file it cannot read', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await chooseFile(user, 'date,sku,quantity\n');
    expect(await screen.findByText('This file has no rows to import.')).toBeInTheDocument();

    const broken = new File(['x'], 'broken.csv', { type: 'text/csv' });
    Object.defineProperty(broken, 'text', { value: () => Promise.reject(new Error('unreadable')) });
    await user.upload(screen.getByLabelText('Choose a CSV file'), broken);
    expect(await screen.findByText('Could not read this file.')).toBeInTheDocument();
  });

  it('closes from the file step with Cancel', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={onOpenChange} settings={settings} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reviews the totals and the unmatched SKUs, then finishes and offers the suggested cut-over date', async () => {
    env.completeImport.mockResolvedValue({ suggestedCutoverDate: '2026-02-01' });
    env.updateSettings.mockResolvedValue({});
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await uploadToReview(user, { imported: 1, skipped: 1, unmatchedSkus: ['W-2', 'W-9'] });

    expect(await screen.findByText('1 rows matched a product and were imported; 1 did not match.')).toBeInTheDocument();
    expect(screen.getByText('W-2, W-9')).toBeInTheDocument();
    expect(env.addRows).toHaveBeenCalledWith({
      id: 'imp_1',
      data: { rows: expect.arrayContaining([expect.objectContaining({ sku: 'W-1', quantity: 3 })]), startRow: 0 },
    });

    await user.click(screen.getByRole('button', { name: 'Finish import' }));
    expect(env.completeImport).toHaveBeenCalledWith('imp_1');
    expect(await screen.findByText(/The sales history now counts in the forecast/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Stop imported history on/ }));
    expect(env.updateSettings).toHaveBeenCalledWith({ historyCutoverDate: '2026-02-01' });
    expect(toast.success).toHaveBeenCalledWith('Cut-over date set');
    expect(screen.queryByText('Avoid counting sales twice')).not.toBeInTheDocument();
  });

  it('keeps the suggestion when setting the cut-over date fails, with a fallback message', async () => {
    env.completeImport.mockResolvedValue({ suggestedCutoverDate: '2026-02-01' });
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await uploadToReview(user, { imported: 2, skipped: 0, unmatchedSkus: [] });
    await user.click(await screen.findByRole('button', { name: 'Finish import' }));

    env.updateSettings.mockRejectedValueOnce(new Error('Not allowed'));
    await user.click(await screen.findByRole('button', { name: /Stop imported history on/ }));
    expect(toast.error).toHaveBeenLastCalledWith('Not allowed');
    env.updateSettings.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: /Stop imported history on/ }));
    expect(toast.error).toHaveBeenLastCalledWith('Could not set the cut-over date');
  });

  it('does not suggest a cut-over date when one is already set', async () => {
    env.completeImport.mockResolvedValue({ suggestedCutoverDate: '2026-02-01' });
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={{ historyCutoverDate: '2026-01-01' } as unknown as ReplenishmentSettings} />);
    await uploadToReview(user, { imported: 2, skipped: 0, unmatchedSkus: [] });
    await user.click(await screen.findByRole('button', { name: 'Finish import' }));
    expect(await screen.findByText(/The sales history now counts in the forecast/)).toBeInTheDocument();
    expect(screen.queryByText('Avoid counting sales twice')).not.toBeInTheDocument();
  });

  it('closes the finished wizard without deleting the import', async () => {
    env.completeImport.mockResolvedValue({ suggestedCutoverDate: null });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={onOpenChange} settings={settings} />);
    await uploadToReview(user, { imported: 2, skipped: 0, unmatchedSkus: [] });
    await user.click(await screen.findByRole('button', { name: 'Finish import' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(env.deleteImport).not.toHaveBeenCalled();
  });

  it('shows why finishing failed, with a fallback message', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await uploadToReview(user, { imported: 2, skipped: 0, unmatchedSkus: [] });
    env.completeImport.mockRejectedValueOnce(new Error('Locked'));
    await user.click(await screen.findByRole('button', { name: 'Finish import' }));
    expect(await screen.findByText('Locked')).toBeInTheDocument();

    env.completeImport.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Finish import' }));
    expect(await screen.findByText('Could not finish the import')).toBeInTheDocument();
  });

  it('discards the import from the review and closes', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={onOpenChange} settings={settings} />);
    await uploadToReview(user, { imported: 2, skipped: 0, unmatchedSkus: [] });
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(env.deleteImport).toHaveBeenCalledWith('imp_1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closing the review deletes the unfinished import', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={onOpenChange} settings={settings} />);
    await uploadToReview(user, { imported: 2, skipped: 0, unmatchedSkus: [] });
    await screen.findByRole('button', { name: 'Finish import' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(env.deleteImport).toHaveBeenCalledWith('imp_1'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot finish when no row matched a product', async () => {
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await uploadToReview(user, { imported: 0, skipped: 2, unmatchedSkus: [] });
    expect(await screen.findByText(/No row matched a product/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish import' })).toBeDisabled();
  });

  it('goes back to the mapping with the error when the upload fails, and removes the half-uploaded import', async () => {
    env.createImport.mockResolvedValue({ id: 'imp_1' });
    env.addRows.mockRejectedValueOnce(new Error('Network down'));
    const user = userEvent.setup();
    render(<ImportWizard open onOpenChange={vi.fn()} settings={settings} />);
    await chooseFile(user, GOOD_CSV);
    await user.click(await screen.findByRole('button', { name: 'Upload 2 rows' }));
    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(env.deleteImport).toHaveBeenCalledWith('imp_1');

    // A retry starts a new import.
    env.createImport.mockResolvedValue({ id: 'imp_2' });
    env.addRows.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Upload 2 rows' }));
    expect(await screen.findByText('The upload failed. Nothing was imported.')).toBeInTheDocument();
    expect(env.createImport).toHaveBeenCalledTimes(2);
    expect(env.deleteImport).toHaveBeenCalledWith('imp_2');
  });
});
