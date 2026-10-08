import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string) => value,
  today: () => '2026-10-20',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { FileReturnDialog } from './file-return-dialog';
import { installPointerPolyfills, makeReturn, renderWithProviders } from '../../shared/test-support';

const ret = makeReturn({ status: 'reviewed' });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.post.mockReset();
  toast.error.mockReset();
  api.post.mockResolvedValue({ data: { ...ret, status: 'filed', warnings: [] } });
});

function renderDialog(props: Partial<React.ComponentProps<typeof FileReturnDialog>> = {}) {
  const handlers = { onOpenChange: vi.fn(), onRecalculate: vi.fn().mockResolvedValue(true), onRecordPayment: vi.fn() };
  renderWithProviders(<FileReturnDialog ret={ret} open {...handlers} {...props} />);
  return handlers;
}

describe('FileReturnDialog', () => {
  it('files with the confirmation number and the date, defaulting to today', async () => {
    renderDialog();
    const user = userEvent.setup();

    expect(screen.getByLabelText('Date filed')).toHaveValue('2026-10-20');
    await user.type(screen.getByLabelText('Confirmation number'), '  WA-2026-0042  ');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/tax-returns/txr_1/file', {
      confirmationNumber: 'WA-2026-0042',
      filedAt: '2026-10-20',
    });
  });

  it('needs a confirmation number', async () => {
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));

    expect(await screen.findByText('Enter the confirmation number')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not accept a date before the period ended', async () => {
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Confirmation number'), 'X1');
    const date = screen.getByLabelText('Date filed');
    await user.clear(date);
    await user.type(date, '2026-09-15');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));

    expect(await screen.findByText('A return cannot be filed before its period ends (2026-09-30).')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('warns that a date after the due date may bring penalty and interest', () => {
    renderDialog();
    // Today (2026-10-20) is before the due date of 2026-10-25.
    expect(screen.queryByTestId('late-notice')).not.toBeInTheDocument();
  });

  it('shows the late notice once the date is after the due date', async () => {
    renderDialog();
    const user = userEvent.setup();

    const date = screen.getByLabelText('Date filed');
    await user.clear(date);
    await user.type(date, '2026-10-30');
    expect(screen.getByTestId('late-notice')).toHaveTextContent('after the due date (2026-10-25)');
  });

  it('tells how many issues the pre-file check found', () => {
    renderDialog({ findingsCount: 2 });
    expect(screen.getByText('The pre-file check found 2 issues. You can still file.')).toBeInTheDocument();
  });

  it('shows what the server says about the filing and offers to record the payment', async () => {
    api.post.mockResolvedValue({
      data: {
        ...ret,
        status: 'filed',
        warnings: [
          { code: 'late_filing', message: 'Filed after the due date (2026-10-25).' },
          { code: 'earlier_period_unfiled', message: 'Earlier period(s) of this agency have no filed return: 2026-06-30.' },
        ],
      },
    });
    const { onOpenChange, onRecordPayment } = renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Confirmation number'), 'X1');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));

    const result = await screen.findByTestId('file-result');
    expect(result).toHaveTextContent('Filed after the due date');
    expect(result).toHaveTextContent('Penalty and interest may apply');
    // A warning we have no sentence for keeps the server's wording, with the dates it names.
    expect(result).toHaveTextContent('Earlier periods are not filed');
    expect(result).toHaveTextContent('2026-06-30');

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRecordPayment).toHaveBeenCalled();
  });

  it('offers a recalculation when the ledger changed since the calculation (409)', async () => {
    api.post.mockRejectedValue(
      Object.assign(
        new Error('The ledger changed since this return was calculated. Recalculate it, review the worksheet and file again.'),
        { status: 409, code: 'CONFLICT', body: {} },
      ),
    );
    const { onRecalculate, onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Confirmation number'), 'X1');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));

    expect(await screen.findByTestId('recalculate-notice')).toHaveTextContent('The ledger changed');
    expect(toast.error).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Recalculate now' }));
    await waitFor(() => expect(onRecalculate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open when the recalculation did not work', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('The ledger changed. Recalculate it and file again.'), { status: 409, code: 'CONFLICT', body: {} }),
    );
    const onRecalculate = vi.fn().mockResolvedValue(false);
    const { onOpenChange } = renderDialog({ onRecalculate });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Confirmation number'), 'X1');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));
    await user.click(await screen.findByRole('button', { name: 'Recalculate now' }));

    await waitFor(() => expect(onRecalculate).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('recalculate-notice')).toBeInTheDocument();
  });

  it('reports any other failure', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('Nope'), { status: 500, code: null, body: {} }));
    renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Confirmation number'), 'X1');
    await user.click(screen.getByRole('button', { name: 'Mark as filed' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not file the return', { description: 'Nope' }));
    expect(screen.queryByTestId('file-result')).not.toBeInTheDocument();
  });
});
