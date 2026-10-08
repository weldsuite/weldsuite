import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DisposeResult, FixedAssetDetail } from '@/lib/api/domains/weldbooks-assets';

const disposeAsync = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-04-15',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_bank', code: '1000', name: 'Checking', type: 'asset', isActive: true },
        { id: 'acc_gain', code: '7000', name: 'Gain or loss on disposal', type: 'revenue', isActive: true },
      ],
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useDisposeFixedAsset: () => ({ mutateAsync: disposeAsync, isPending: false }),
}));

import { DisposeDialog } from './dispose-dialog';
import { polyfillRadixSelect, renderWithProviders } from '../test-utils';

/** A 1200.00 asset depreciated 100.00 a month from January; January to March end before the disposal date. */
const asset = {
  id: 'fa_1',
  name: 'Forklift',
  cost: '1200.00',
  placedInServiceDate: '2026-01-01',
  books: [{ id: 'fab_1', book: 'book', postsToLedger: true }],
  ledgerRows: ['01', '02', '03', '04'].map((month) => ({
    id: `fad_${month}`,
    assetId: 'fa_1',
    bookId: 'fab_1',
    periodStart: `2026-${month}-01`,
    periodEnd: `2026-${month}-28`,
    amount: '100.00',
    accumulated: `${Number(month) * 100}.00`,
    journalEntryId: month === '01' ? 'je_1' : null,
  })),
} as unknown as FixedAssetDetail;

describe('DisposeDialog', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    disposeAsync.mockReset();
  });

  const open = (onOpenChange = vi.fn()) => renderWithProviders(<DisposeDialog asset={asset} open onOpenChange={onOpenChange} />);

  it('previews net book value and a loss when the asset is scrapped', async () => {
    open();
    const preview = await screen.findByTestId('dispose-preview');
    // 2026-04-15: January, February and March ended before the disposal date.
    expect(within(preview).getByTestId('preview-cost')).toHaveTextContent('$1200.00');
    expect(within(preview).getByTestId('preview-accumulated')).toHaveTextContent('$300.00');
    expect(within(preview).getByTestId('preview-nbv')).toHaveTextContent('$900.00');
    expect(within(preview).getByTestId('dispose-verdict')).toHaveAttribute('data-result', 'loss');
    expect(within(preview).getByTestId('dispose-verdict')).toHaveTextContent('Loss on disposal');
    expect(within(preview).getByTestId('dispose-verdict')).toHaveTextContent('$900.00');
  });

  it('previews a gain when the proceeds are above net book value', async () => {
    const user = userEvent.setup();
    open();
    const proceeds = await screen.findByLabelText('Proceeds');
    await user.clear(proceeds);
    await user.type(proceeds, '1000');

    const verdict = screen.getByTestId('dispose-verdict');
    expect(verdict).toHaveAttribute('data-result', 'gain');
    expect(verdict).toHaveTextContent('Gain on disposal');
    expect(verdict).toHaveTextContent('$100.00');
    expect(screen.getByTestId('preview-proceeds')).toHaveTextContent('$1000.00');
  });

  it('shows no gain or loss when the proceeds equal net book value, and follows the date', async () => {
    const user = userEvent.setup();
    open();
    const proceeds = await screen.findByLabelText('Proceeds');
    await user.clear(proceeds);
    await user.type(proceeds, '900');
    expect(screen.getByTestId('dispose-verdict')).toHaveAttribute('data-result', 'none');

    // Moving the date to May adds April's depreciation: net book value is 800 and 900 is a gain of 100.
    const date = screen.getByLabelText('Disposal date');
    await user.clear(date);
    await user.type(date, '2026-05-10');
    expect(screen.getByTestId('preview-accumulated')).toHaveTextContent('$400.00');
    expect(screen.getByTestId('dispose-verdict')).toHaveAttribute('data-result', 'gain');
  });

  it('refuses a disposal before the asset was placed in service and a bad amount', async () => {
    const user = userEvent.setup();
    open();
    const date = await screen.findByLabelText('Disposal date');
    await user.clear(date);
    await user.type(date, '2025-12-31');
    expect(screen.getByTestId('dispose-problem')).toHaveTextContent('before it was placed in service (2026-01-01)');
    expect(screen.getByTestId('dispose-submit')).toBeDisabled();

    await user.clear(date);
    await user.type(date, '2026-04-15');
    const proceeds = screen.getByLabelText('Proceeds');
    await user.clear(proceeds);
    await user.type(proceeds, '-5');
    expect(screen.getByTestId('dispose-problem')).toHaveTextContent('Enter the proceeds');
    expect(screen.getByTestId('dispose-submit')).toBeDisabled();
  });

  it('only asks where the proceeds went when there are proceeds', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('dispose-preview');
    expect(screen.queryByLabelText('Proceeds received in')).not.toBeInTheDocument();
    const proceeds = screen.getByLabelText('Proceeds');
    await user.clear(proceeds);
    await user.type(proceeds, '250');
    expect(screen.getByLabelText('Proceeds received in')).toBeInTheDocument();
  });

  it('disposes with the date and proceeds and shows the server’s gain with the tax books', async () => {
    const result: DisposeResult = {
      asset: { ...asset, status: 'disposed' } as never,
      journalEntryId: 'je_77',
      entryNumber: 'JE-77',
      proceeds: 1000,
      accumulatedDepreciation: 300,
      netBookValue: 900,
      gainOrLoss: 100,
      result: 'gain',
      catchUp: [{ periodEnd: '2026-03-31', journalEntryId: 'je_5', entryNumber: null, amount: 200, assets: 1, alreadyPosted: false }],
      disposalMonthDepreciation: 0,
      taxBooks: [
        {
          book: 'federal',
          stateCode: null,
          method: 'macrs_gds',
          accumulated: 1200,
          proceeds: 1000,
          adjustedBasis: 0,
          gainOrLoss: 1000,
          result: 'gain',
          ordinaryRecapture: 1000,
          unrecapturedSection1250: 0,
          remainingGain: 0,
        },
      ],
    };
    disposeAsync.mockResolvedValue(result);
    const user = userEvent.setup();
    open();

    const proceeds = await screen.findByLabelText('Proceeds');
    await user.clear(proceeds);
    await user.type(proceeds, '1000');
    await user.click(screen.getByTestId('dispose-submit'));

    await waitFor(() => expect(disposeAsync).toHaveBeenCalledTimes(1));
    expect(disposeAsync).toHaveBeenCalledWith({ id: 'fa_1', input: { date: '2026-04-15', proceeds: 1000 } });

    const done = await screen.findByTestId('dispose-result');
    expect(within(done).getByTestId('dispose-verdict')).toHaveTextContent('Gain on disposal: $100.00');
    expect(within(done).getByText('Net book value at disposal: $900.00')).toBeInTheDocument();
    expect(within(done).getByText('Federal tax')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'View the disposal entry' })).toHaveAttribute('href', '/weldbooks/journal/$id');
  });

  it('keeps the form and shows the error when the server refuses', async () => {
    disposeAsync.mockRejectedValue(new Error('The period is locked'));
    const user = userEvent.setup();
    open();

    await user.click(await screen.findByTestId('dispose-submit'));
    expect(await screen.findByTestId('dispose-error')).toHaveTextContent('The period is locked');
    expect(screen.getByTestId('dispose-preview')).toBeInTheDocument();
  });
});
