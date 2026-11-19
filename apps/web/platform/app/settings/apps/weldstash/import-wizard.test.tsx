import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
