import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReplenishmentSettings, SalesHistoryImport } from '@weldsuite/app-api-client/schemas/replenishment';

interface Query<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const env = vi.hoisted(() => ({
  settings: undefined as unknown,
  imports: undefined as unknown,
  permissions: new Set<string>(),
  update: vi.fn(),
  remove: vi.fn(),
  refetchSettings: vi.fn(),
  refetchImports: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/queries/use-replenishment-queries', () => ({
  useReplenishmentSettings: () => env.settings,
  useSalesHistoryImports: () => env.imports,
  useUpdateReplenishmentSettings: () => ({ mutateAsync: env.update, isPending: false }),
  useDeleteSalesHistoryImport: () => ({ mutateAsync: env.remove, isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashWarehouses: () => ({ data: { data: [{ id: 'w1', name: 'Main' }] } }),
}));
vi.mock('./import-wizard', () => ({
  ImportWizard: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => (
    <div data-testid="wizard">
      <button onClick={() => onOpenChange(false)}>close wizard</button>
    </div>
  ),
}));

import { SettingsTab } from './settings-tab';

const baseSettings: ReplenishmentSettings = {
  id: 'default',
  replenishmentEnabled: true,
  defaultServiceLevel: '0.950',
  defaultReviewPeriodDays: 7,
  lookbackDays: 365,
  defaultLeadTimeDays: 14,
  demandWarehouseId: null,
  historyCutoverDate: null,
  runHourUtc: 2,
};

function ready<T>(data: T): Query<T> {
  return { data, isLoading: false, isError: false, error: null, refetch: vi.fn() };
}

function importRow(overrides: Partial<SalesHistoryImport> = {}): SalesHistoryImport {
  return {
    id: 'imp_1',
    fileName: 'sales-2025.csv',
    status: 'done',
    rowsImported: 120,
    rowsSkipped: 3,
    dateFrom: '2025-01-01',
    dateTo: '2025-12-31',
    createdAt: '2026-11-10T09:00:00Z',
    ...overrides,
  } as SalesHistoryImport;
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  env.settings = { ...ready(baseSettings), refetch: env.refetchSettings };
  env.imports = { ...ready([] as SalesHistoryImport[]), refetch: env.refetchImports };
  env.permissions = new Set(['inventory:manage']);
  env.update.mockReset().mockResolvedValue({});
  env.remove.mockReset().mockResolvedValue(undefined);
  env.refetchSettings.mockReset();
  env.refetchImports.mockReset();
  env.toast.success.mockReset();
  env.toast.error.mockReset();
});

describe('SettingsTab', () => {
  it('shows a loader while the settings load', () => {
    env.settings = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
    render(<SettingsTab />);
    expect(screen.queryByText('Replenishment')).not.toBeInTheDocument();
  });

  it('shows the error with a retry when the settings fail', async () => {
    env.settings = { data: undefined, isLoading: false, isError: true, error: new Error('Down'), refetch: env.refetchSettings };
    const user = userEvent.setup();
    render(<SettingsTab />);
    expect(screen.getByText('Down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetchSettings).toHaveBeenCalled();
  });

  it('shows a generic message when the settings fail without one', () => {
    env.settings = { data: undefined, isLoading: false, isError: true, error: null, refetch: vi.fn() };
    render(<SettingsTab />);
    expect(screen.getByText('Could not load the settings.')).toBeInTheDocument();
  });

  it('fills the form from the settings', () => {
    env.settings = ready({ ...baseSettings, historyCutoverDate: '2026-01-15' });
    render(<SettingsTab />);
    expect(screen.getByLabelText('Service level')).toHaveValue('95');
    expect(screen.getByLabelText('Review period')).toHaveValue('7');
    expect(screen.getByLabelText('Look back')).toHaveValue('365');
    expect(screen.getByLabelText('Default lead time')).toHaveValue('14');
    expect(screen.getByLabelText('Imported history stops on')).toHaveValue('2026-01-15');
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('keeps Save disabled until something changed, then saves the new values', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();

    const lookback = screen.getByLabelText('Look back');
    await user.clear(lookback);
    await user.type(lookback, '180');
    await user.click(screen.getByRole('switch'));
    await user.click(save);

    expect(env.update).toHaveBeenCalledWith(
      expect.objectContaining({ lookbackDays: 180, replenishmentEnabled: false, defaultServiceLevel: 0.95, runHourUtc: 2 }),
    );
    expect(env.toast.success).toHaveBeenCalledWith('Settings saved');
  });

  it('saves a demand warehouse, the run hour and a cut-over date', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole('combobox', { name: 'Warehouse for sales without a pick list' }));
    await user.click(await screen.findByRole('option', { name: 'Main' }));
    await user.click(screen.getByRole('combobox', { name: 'Nightly calculation' }));
    await user.click(await screen.findByRole('option', { name: '05:00 UTC' }));
    await user.type(screen.getByLabelText('Imported history stops on'), '2026-03-01');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(env.update).toHaveBeenCalledWith(
      expect.objectContaining({ demandWarehouseId: 'w1', runHourUtc: 5, historyCutoverDate: '2026-03-01' }),
    );
  });

  it('can go back to the default warehouse', async () => {
    env.settings = ready({ ...baseSettings, demandWarehouseId: 'w1' });
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole('combobox', { name: 'Warehouse for sales without a pick list' }));
    await user.click(await screen.findByRole('option', { name: 'The default warehouse' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(env.update).toHaveBeenCalledWith(expect.objectContaining({ demandWarehouseId: null }));
  });

  it('refuses text in a number field and does not call the API', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    const lookback = screen.getByLabelText('Look back');
    await user.clear(lookback);
    await user.type(lookback, 'abc');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Check this value')).toBeInTheDocument();
    expect(env.update).not.toHaveBeenCalled();
  });

  it('shows the server message when saving fails, and a fallback without one', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    await user.click(screen.getByRole('switch'));
    env.update.mockRejectedValueOnce(new Error('Forbidden'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Forbidden');

    env.update.mockRejectedValueOnce(new Error(''));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not save the settings');
  });

  it('loads a new cut-over date that arrives from the server into the form', () => {
    const { rerender } = render(<SettingsTab />);
    expect(screen.getByLabelText('Imported history stops on')).toHaveValue('');
    env.settings = ready({ ...baseSettings, historyCutoverDate: '2026-02-02', updatedAt: '2026-11-19T10:00:00Z' } as ReplenishmentSettings);
    rerender(<SettingsTab />);
    expect(screen.getByLabelText('Imported history stops on')).toHaveValue('2026-02-02');
  });

  it('is read-only without the manage permission', () => {
    env.permissions = new Set();
    env.imports = ready([importRow()]);
    render(<SettingsTab />);
    expect(screen.getByText('You can see these settings but not change them.')).toBeInTheDocument();
    expect(screen.getByLabelText('Look back')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import CSV' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open row actions' })).not.toBeInTheDocument();
  });
});

describe('sales history imports', () => {
  it('shows an empty text when nothing was imported', () => {
    render(<SettingsTab />);
    expect(screen.getByText('No sales history imported yet.')).toBeInTheDocument();
  });

  it('shows a spinner while the imports load and an error with a retry when they fail', async () => {
    env.imports = { data: undefined, isLoading: true, isError: false, error: null, refetch: env.refetchImports };
    const { rerender } = render(<SettingsTab />);
    expect(screen.queryByText('No sales history imported yet.')).not.toBeInTheDocument();

    env.imports = { data: undefined, isLoading: false, isError: true, error: new Error('Imports down'), refetch: env.refetchImports };
    rerender(<SettingsTab />);
    expect(screen.getByText('Imports down')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(env.refetchImports).toHaveBeenCalled();
  });

  it('shows a generic message when the imports fail without one', () => {
    env.imports = { data: undefined, isLoading: false, isError: true, error: null, refetch: vi.fn() };
    render(<SettingsTab />);
    expect(screen.getByText('Could not load the imports.')).toBeInTheDocument();
  });

  it('lists the imports with their status, rows and dates', () => {
    env.imports = ready([
      importRow(),
      importRow({ id: 'imp_2', fileName: 'broken.csv', status: 'failed', dateFrom: null, dateTo: null, rowsImported: 0, rowsSkipped: 9 }),
      importRow({ id: 'imp_3', fileName: 'busy.csv', status: 'processing' }),
      importRow({ id: 'imp_4', fileName: 'odd.csv', status: 'archived' as SalesHistoryImport['status'] }),
    ]);
    render(<SettingsTab />);
    expect(screen.getByText('sales-2025.csv')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('archived')).toBeInTheDocument();
    expect(screen.getAllByText('120 imported, 3 skipped')).toHaveLength(3);
    expect(screen.getByText('0 imported, 9 skipped')).toBeInTheDocument();
    expect(screen.getAllByText(/Jan 1, 2025.*Dec 31, 2025/).length).toBeGreaterThan(0);
  });

  it('opens and closes the import wizard', async () => {
    const user = userEvent.setup();
    render(<SettingsTab />);
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import CSV' }));
    expect(screen.getByTestId('wizard')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close wizard' }));
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
  });

  async function openDelete(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Open row actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete import' }));
    return screen.findByRole('dialog');
  }

  it('asks before deleting an import, then deletes it', async () => {
    env.imports = ready([importRow()]);
    const user = userEvent.setup();
    render(<SettingsTab />);
    const dialog = await openDelete(user);
    expect(within(dialog).getByText('The rows of sales-2025.csv are removed and no longer count as demand.')).toBeInTheDocument();
    expect(env.remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete import' }));
    expect(env.remove).toHaveBeenCalledWith('imp_1');
    expect(env.toast.success).toHaveBeenCalledWith('Import deleted');
  });

  it('keeps the import when the delete is cancelled', async () => {
    env.imports = ready([importRow()]);
    const user = userEvent.setup();
    render(<SettingsTab />);
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(env.remove).not.toHaveBeenCalled();
  });

  it('shows why a delete failed, with a fallback message', async () => {
    env.imports = ready([importRow()]);
    const user = userEvent.setup();
    render(<SettingsTab />);
    env.remove.mockRejectedValueOnce(new Error('In use'));
    let dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete import' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('In use');

    env.remove.mockRejectedValueOnce(new Error(''));
    dialog = await openDelete(user);
    await user.click(within(dialog).getByRole('button', { name: 'Delete import' }));
    expect(env.toast.error).toHaveBeenLastCalledWith('Could not delete the import');
  });
});
