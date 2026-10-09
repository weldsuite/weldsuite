import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DepreciationRunResult } from '@/lib/api/domains/weldbooks-assets';

const runAsync = vi.fn();
const permissions = new Set(['journal:create']);

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-03-10',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useRunDepreciation: () => ({ mutateAsync: runAsync, isPending: false }),
}));

import DepreciationRunPage from './page';
import { renderWithProviders } from '../test-utils';

const result: DepreciationRunResult = {
  through: '2026-02-28',
  posted: [
    { periodEnd: '2026-01-31', journalEntryId: 'je_1', entryNumber: 'JE-101', amount: 450.5, assets: 3, alreadyPosted: false },
    { periodEnd: '2026-02-28', journalEntryId: 'je_2', entryNumber: null, amount: 450.5, assets: 3, alreadyPosted: true },
  ],
  skipped: [{ periodEnd: '2025-12-31', assets: 3, amount: 450.5, reason: 'The period is locked' }],
  fullyDepreciatedAssetIds: ['fa_9'],
  totalPosted: 450.5,
};

describe('Depreciation run page', () => {
  beforeEach(() => {
    runAsync.mockReset().mockResolvedValue(result);
    permissions.clear();
    permissions.add('journal:create');
  });

  it('starts at the end of last month and asks before it posts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepreciationRunPage />);

    expect(screen.getByLabelText('Post through')).toHaveValue('2026-02-28');
    await user.click(screen.getByTestId('run-open'));

    expect(await screen.findByText('Post depreciation through 2026-02-28?')).toBeInTheDocument();
    expect(runAsync).not.toHaveBeenCalled();
  });

  it('posts through the chosen date once confirmed and shows what was posted and what was skipped', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepreciationRunPage />);

    await user.click(screen.getByTestId('run-open'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Post depreciation' }));

    await waitFor(() => expect(runAsync).toHaveBeenCalledWith('2026-02-28'));
    const done = await screen.findByTestId('run-result');
    expect(within(done).getByTestId('run-total')).toHaveTextContent('$450.50');
    // Only the entry the run created counts; the one that already existed is flagged.
    expect(within(done).getByText('Already posted')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'JE-101' })).toHaveAttribute('href', '/weldbooks/journal/$id');

    const skipped = within(done).getByTestId('run-skipped');
    expect(skipped).toHaveTextContent('2025-12-31');
    expect(skipped).toHaveTextContent('The period is locked');
    expect(skipped).toHaveTextContent('Unlock or reopen these periods');
  });

  it('does not run without a valid date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DepreciationRunPage />);
    await user.clear(screen.getByLabelText('Post through'));
    expect(screen.getByTestId('run-open')).toBeDisabled();
    expect(screen.getByText('Choose a date.')).toBeInTheDocument();
  });

  it('shows the error when the run fails', async () => {
    runAsync.mockRejectedValueOnce(new Error('No accounting entity resolved'));
    const user = userEvent.setup();
    renderWithProviders(<DepreciationRunPage />);

    await user.click(screen.getByTestId('run-open'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Post depreciation' }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent('No accounting entity resolved');
    expect(screen.queryByTestId('run-result')).not.toBeInTheDocument();
  });

  it('says so when there was nothing to post', async () => {
    runAsync.mockResolvedValueOnce({ through: '2026-02-28', posted: [], skipped: [], fullyDepreciatedAssetIds: [], totalPosted: 0 });
    const user = userEvent.setup();
    renderWithProviders(<DepreciationRunPage />);

    await user.click(screen.getByTestId('run-open'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Post depreciation' }));
    expect(await screen.findByText(/Nothing to post/)).toBeInTheDocument();
  });

  it('is closed without journal:create', () => {
    permissions.clear();
    renderWithProviders(<DepreciationRunPage />);
    expect(screen.getByText('You do not have access to this screen.')).toBeInTheDocument();
  });
});
