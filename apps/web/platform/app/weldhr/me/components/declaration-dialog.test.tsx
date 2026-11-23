import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const t = en.weldhr.me.declarations.form;

const mocks = vi.hoisted(() => ({ create: vi.fn(), toastSuccess: vi.fn(), toastWarning: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, warning: mocks.toastWarning } }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrCreateDeclaration: () => ({ mutateAsync: mocks.create, isPending: false }),
}));

import { MyDeclarationDialog } from './declaration-dialog';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function renderDialog(onClose = vi.fn()) {
  renderWithProviders(<MyDeclarationDialog onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
}

const submit = () => screen.getByRole('button', { name: t.submit });

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.create.mockResolvedValue({ declaration: {}, receiptFailed: false });
});

describe('MyDeclarationDialog', () => {
  it('opens on today with Submit disabled until the form is valid', async () => {
    const { user } = renderDialog();
    expect(screen.getByText(t.title)).toBeInTheDocument();
    expect(submit()).toBeDisabled();

    await user.type(screen.getByPlaceholderText('0.00'), '12,50');
    expect(submit()).toBeDisabled();
    await user.type(screen.getByPlaceholderText(t.descriptionPlaceholder), 'Train ticket');
    await waitFor(() => expect(submit()).toBeEnabled());
  });

  it('shows the amount error as you type, and keeps Submit disabled', async () => {
    const { user } = renderDialog();
    await user.type(screen.getByPlaceholderText('0.00'), '0');
    expect(await screen.findByText(t.errors.amount)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it('submits the declaration with the amount parsed, and closes with a toast', async () => {
    const { user, onClose } = renderDialog();
    await user.type(screen.getByPlaceholderText('0.00'), '12,50');
    await user.type(screen.getByPlaceholderText(t.descriptionPlaceholder), '  Train ticket  ');
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      category: 'travel',
      amount: 12.5,
      currency: 'EUR',
      description: 'Train ticket',
      receipt: null,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t.submittedToast);
    expect(onClose).toHaveBeenCalled();
  });

  it('attaches a valid receipt, and warns when the upload failed', async () => {
    mocks.create.mockResolvedValue({ declaration: {}, receiptFailed: true });
    const { user, onClose } = renderDialog();
    await user.type(screen.getByPlaceholderText('0.00'), '5');
    await user.type(screen.getByPlaceholderText(t.descriptionPlaceholder), 'Parking');
    const file = new File(['%PDF'], 'parking.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText(t.receipt), file);
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0].receipt).toBe(file);
    expect(mocks.toastWarning).toHaveBeenCalledWith(t.receiptUploadFailed);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses a receipt of the wrong type and disables Submit', async () => {
    renderDialog();
    // The file input's accept list would keep a text file out of a real picker; a drop or paste can still bring one.
    const user = userEvent.setup({ applyAccept: false });
    await user.type(screen.getByPlaceholderText('0.00'), '5');
    await user.type(screen.getByPlaceholderText(t.descriptionPlaceholder), 'Parking');
    await user.upload(screen.getByLabelText(t.receipt), new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(await screen.findByText(t.errors.receiptType)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it('refuses a receipt that is too large', async () => {
    const { user } = renderDialog();
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await user.upload(screen.getByLabelText(t.receipt), big);
    expect(await screen.findByText(t.errors.receiptTooLarge)).toBeInTheDocument();
  });

  it('shows the failure of the server in a banner', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Receipts are full'));
    const { user, onClose } = renderDialog();
    await user.type(screen.getByPlaceholderText('0.00'), '5');
    await user.type(screen.getByPlaceholderText(t.descriptionPlaceholder), 'Parking');
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    expect(await screen.findByText('Receipts are full')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes with Cancel', async () => {
    const { user, onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
    expect(onClose).toHaveBeenCalled();
  });
});
