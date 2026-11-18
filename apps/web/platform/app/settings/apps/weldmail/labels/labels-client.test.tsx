import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { LabelsClient } from './labels-client';

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

type Callbacks = { onSuccess?: (r: { data: Record<string, unknown> }) => void; onError?: (e: unknown) => void };
const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();
let pending = { create: false, update: false };

vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useCreateMailLabel: () => ({ mutate: createMutate, isPending: pending.create }),
  useUpdateMailLabel: () => ({ mutate: updateMutate, isPending: pending.update }),
  useDeleteMailLabel: () => ({ mutate: deleteMutate, isPending: false }),
}));

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => true }));

const L = en.mail.settingsLabels;

const labels = [
  { id: 'l1', name: 'Invoices', color: '#EF4444', count: 3, aiEnabled: true, aiKeywords: ['invoice', 'bill'], aiDescription: 'Billing mail', aiConfidence: 80 },
  { id: 'l2', name: 'Travel', color: 'green', count: 1 },
  { id: 'l3', name: 'Misc', color: 'unknown-name', count: 0 },
  { name: 'NoId', count: 0 },
];

function renderClient(initial: unknown[] = labels) {
  return render(<LabelsClient initialLabels={initial as never} accountId="acc1" />);
}

const lastCallbacks = (m: ReturnType<typeof vi.fn>): Callbacks => m.mock.calls.at(-1)![1];

describe('LabelsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending = { create: false, update: false };
  });

  it('lists labels with counts and the AI badge', () => {
    renderClient();
    expect(screen.getByText('Invoices')).toBeTruthy();
    expect(screen.getByText(`(3 ${L.emailPlural})`)).toBeTruthy();
    expect(screen.getByText(`(1 ${L.emailSingular})`)).toBeTruthy();
    expect(screen.getAllByText('AI').length).toBeGreaterThan(0);
    expect(screen.getByText(L.youHaveLabelsPlural.replace('{count}', '4'))).toBeTruthy();
  });

  it('shows the empty state and singular summary', () => {
    const { unmount } = renderClient([]);
    expect(screen.getByText(L.noLabelsYet)).toBeTruthy();
    expect(screen.getByText(L.noLabelsFound)).toBeTruthy();
    unmount();
    renderClient([labels[1]]);
    expect(screen.getByText(L.youHaveLabels.replace('{count}', '1'))).toBeTruthy();
  });

  describe('create', () => {
    const openDialog = () => {
      fireEvent.click(screen.getByTestId('labels-create-btn'));
      return screen.getByRole('dialog');
    };

    it('rejects an empty name', () => {
      renderClient();
      const dialog = openDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: L.create }));
      expect(toastError).toHaveBeenCalledWith(L.labelNameEmpty);
      expect(createMutate).not.toHaveBeenCalled();
    });

    it('rejects a duplicate name, case-insensitively', () => {
      renderClient();
      const dialog = openDialog();
      fireEvent.change(within(dialog).getByPlaceholderText(L.enterLabelName), { target: { value: 'invoices' } });
      fireEvent.click(within(dialog).getByRole('button', { name: L.create }));
      expect(toastError).toHaveBeenCalledWith(L.labelNameExists);
      expect(createMutate).not.toHaveBeenCalled();
    });

    it('creates a label with colour and AI settings and adds it to the list', async () => {
      renderClient();
      const dialog = openDialog();
      fireEvent.change(within(dialog).getByPlaceholderText(L.enterLabelName), { target: { value: '  Receipts ' } });

      fireEvent.click(within(dialog).getByRole('button', { name: en.mail.a11y.labelColor }));
      fireEvent.click(await screen.findByTitle(L.colorRed));

      fireEvent.click(within(dialog).getByRole('switch'));
      fireEvent.change(within(dialog).getByPlaceholderText(L.keywordsPlaceholder), { target: { value: 'a, b ,, c' } });
      fireEvent.change(within(dialog).getByPlaceholderText(L.aiDescriptionPlaceholder), { target: { value: ' Shop receipts ' } });
      fireEvent.keyDown(within(dialog).getByRole('slider'), { key: 'ArrowRight' });

      fireEvent.click(within(dialog).getByRole('button', { name: L.create }));

      expect(createMutate).toHaveBeenCalledTimes(1);
      const payload = createMutate.mock.calls[0][0];
      expect(payload).toMatchObject({
        accountId: 'acc1',
        name: 'Receipts',
        color: '#EF4444',
        aiEnabled: true,
        aiKeywords: ['a', 'b', 'c'],
        aiDescription: 'Shop receipts',
      });
      expect(payload.aiConfidence).toBeGreaterThanOrEqual(70);

      act(() => {
        lastCallbacks(createMutate).onSuccess!({
          data: { id: 'l9', name: 'Receipts', color: '#EF4444', messageCount: null, aiEnabled: true, aiKeywords: ['a'], aiDescription: null, aiConfidence: 75 },
        });
      });
      expect(toastSuccess).toHaveBeenCalledWith(L.labelCreatedSuccessfully);
      expect(screen.getByText('Receipts')).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('creates a plain label without AI fields on Enter', () => {
      renderClient();
      const dialog = openDialog();
      const input = within(dialog).getByPlaceholderText(L.enterLabelName);
      fireEvent.change(input, { target: { value: 'Plain' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(createMutate.mock.calls[0][0]).toMatchObject({
        name: 'Plain',
        color: '#3B82F6',
        aiEnabled: false,
        aiKeywords: [],
        aiDescription: undefined,
        aiConfidence: undefined,
      });
    });

    it('shows the server message, or a fallback, when create fails', () => {
      renderClient();
      const dialog = openDialog();
      fireEvent.change(within(dialog).getByPlaceholderText(L.enterLabelName), { target: { value: 'X1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: L.create }));
      act(() => lastCallbacks(createMutate).onError!(new Error('Boom')));
      expect(toastError).toHaveBeenCalledWith('Boom');
      act(() => lastCallbacks(createMutate).onError!('nope'));
      expect(toastError).toHaveBeenCalledWith(L.failedToCreateLabel);
    });

    it('cancels the dialog', async () => {
      renderClient();
      const dialog = openDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: L.cancel }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('disables the buttons and shows progress while creating', () => {
      pending.create = true;
      renderClient();
      const dialog = openDialog();
      expect((within(dialog).getByRole('button', { name: L.creating }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.keyDown(within(dialog).getByPlaceholderText(L.enterLabelName), { key: 'Enter' });
      expect(toastError).not.toHaveBeenCalled();
    });
  });

  describe('inline rename', () => {
    const start = (name = 'Invoices') => {
      fireEvent.click(screen.getByTestId(`label-rename-btn-${name}`));
      return screen.getByRole('textbox', { name: en.mail.a11y.labelName });
    };

    it('saves a new name and updates the row', () => {
      renderClient();
      const input = start();
      fireEvent.change(input, { target: { value: ' Bills ' } });
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
      expect(updateMutate).toHaveBeenCalledWith({ id: 'l1', name: 'Bills' }, expect.any(Object));
      act(() => lastCallbacks(updateMutate).onSuccess!({ data: {} }));
      expect(toastSuccess).toHaveBeenCalledWith(L.labelRenamedSuccessfully);
      expect(screen.getByText('Bills')).toBeTruthy();
      expect(screen.queryByRole('textbox', { name: en.mail.a11y.labelName })).toBeNull();
    });

    it('saves on Enter and cancels on Escape or the cancel button', () => {
      renderClient();
      let input = start();
      fireEvent.change(input, { target: { value: 'Bills' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(updateMutate).toHaveBeenCalledTimes(1);

      input = screen.getByRole('textbox', { name: en.mail.a11y.labelName });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByRole('textbox', { name: en.mail.a11y.labelName })).toBeNull();

      start('Travel');
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.cancel }));
      expect(screen.queryByRole('textbox', { name: en.mail.a11y.labelName })).toBeNull();
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });

    it('treats an unchanged name as a cancel', () => {
      renderClient();
      start();
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
      expect(updateMutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: en.mail.a11y.labelName })).toBeNull();
    });

    it('rejects empty and duplicate names', () => {
      renderClient();
      const input = start();
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
      expect(toastError).toHaveBeenLastCalledWith(L.labelNameEmpty);
      fireEvent.change(input, { target: { value: 'travel' } });
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
      expect(toastError).toHaveBeenLastCalledWith(L.labelNameExists);
      expect(updateMutate).not.toHaveBeenCalled();
    });

    it('reports a label without an id', () => {
      renderClient();
      const input = start('NoId');
      fireEvent.change(input, { target: { value: 'Other' } });
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
      expect(toastError).toHaveBeenCalledWith(L.labelNotFound);
      expect(updateMutate).not.toHaveBeenCalled();
    });

    it('shows an error when the rename fails', () => {
      renderClient();
      const input = start();
      fireEvent.change(input, { target: { value: 'Bills' } });
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.save }));
      act(() => lastCallbacks(updateMutate).onError!(new Error('Denied')));
      expect(toastError).toHaveBeenCalledWith('Denied');
      act(() => lastCallbacks(updateMutate).onError!(undefined));
      expect(toastError).toHaveBeenCalledWith(L.failedToRenameLabel);
    });
  });

  describe('edit dialog', () => {
    const open = (name = 'Invoices') => {
      fireEvent.click(screen.getByTestId(`label-settings-btn-${name}`));
      return screen.getByRole('dialog');
    };

    it('is prefilled from the label', () => {
      renderClient();
      const dialog = open();
      expect((within(dialog).getByLabelText(L.name) as HTMLInputElement).value).toBe('Invoices');
      expect((within(dialog).getByLabelText(L.keywords) as HTMLInputElement).value).toBe('invoice, bill');
      expect((within(dialog).getByLabelText(L.aiDescriptionLabel) as HTMLTextAreaElement).value).toBe('Billing mail');
      expect(within(dialog).getByText('80%')).toBeTruthy();
      expect(within(dialog).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    });

    it('falls back to defaults for a bare label and closes on cancel', async () => {
      renderClient();
      const dialog = open('NoId');
      expect(within(dialog).getByText('70%')).toBeTruthy();
      expect(within(dialog).getByRole('switch').getAttribute('aria-checked')).toBe('false');
      fireEvent.click(within(dialog).getByRole('button', { name: L.cancel }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('saves changed name and AI settings and updates the list', async () => {
      renderClient();
      const dialog = open();
      fireEvent.change(within(dialog).getByLabelText(L.name), { target: { value: 'Bills' } });
      fireEvent.change(within(dialog).getByLabelText(L.keywords), { target: { value: 'x, y' } });
      fireEvent.change(within(dialog).getByLabelText(L.aiDescriptionLabel), { target: { value: '  ' } });
      fireEvent.keyDown(within(dialog).getByRole('slider'), { key: 'ArrowRight' });
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));

      expect(updateMutate).toHaveBeenCalledTimes(1);
      const payload = updateMutate.mock.calls[0][0];
      expect(payload).toMatchObject({
        id: 'l1',
        name: 'Bills',
        color: '#EF4444',
        aiEnabled: true,
        aiKeywords: ['x', 'y'],
        aiDescription: undefined,
      });
      expect(payload.aiConfidence).toBeGreaterThanOrEqual(80);

      act(() => {
        lastCallbacks(updateMutate).onSuccess!({
          data: { id: 'l1', name: 'Bills', color: '#EF4444', messageCount: 3, aiEnabled: true, aiKeywords: ['x', 'y'], aiDescription: null, aiConfidence: 85 },
        });
      });
      expect(toastSuccess).toHaveBeenCalledWith(L.labelUpdatedSuccessfully);
      expect(screen.getByText('Bills')).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('turns AI off and omits the confidence', () => {
      renderClient();
      const dialog = open();
      fireEvent.click(within(dialog).getByRole('switch'));
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      expect(updateMutate.mock.calls[0][0]).toMatchObject({ aiEnabled: false, aiConfidence: undefined });
    });

    it('changes the colour through the select', async () => {
      renderClient();
      const dialog = open();
      fireEvent.click(within(dialog).getByRole('combobox'));
      fireEvent.click(await screen.findByRole('option', { name: L.colorGreen }));
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      expect(updateMutate.mock.calls[0][0].color).toBe('#22C55E');
    });

    it('validates the name and ignores the label itself as a duplicate', () => {
      renderClient();
      const dialog = open();
      const name = within(dialog).getByLabelText(L.name);
      fireEvent.change(name, { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      expect(toastError).toHaveBeenLastCalledWith(L.labelNameEmpty);
      fireEvent.change(name, { target: { value: 'TRAVEL' } });
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      expect(toastError).toHaveBeenLastCalledWith(L.labelNameExists);
      expect(updateMutate).not.toHaveBeenCalled();
      fireEvent.change(name, { target: { value: 'invoices' } });
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });

    it('does nothing for a label without an id', () => {
      renderClient();
      const dialog = open('NoId');
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      expect(updateMutate).not.toHaveBeenCalled();
    });

    it('shows an error when the update fails', () => {
      renderClient();
      const dialog = open();
      fireEvent.click(within(dialog).getByRole('button', { name: L.saveChanges }));
      act(() => lastCallbacks(updateMutate).onError!(new Error('Nope')));
      expect(toastError).toHaveBeenCalledWith('Nope');
      act(() => lastCallbacks(updateMutate).onError!(0));
      expect(toastError).toHaveBeenCalledWith(L.failedToUpdateLabel);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('shows progress while saving', () => {
      pending.update = true;
      renderClient();
      const dialog = open();
      expect((within(dialog).getByRole('button', { name: L.saving }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('delete', () => {
    const askDelete = (name = 'Travel') => {
      fireEvent.click(screen.getByTestId(`label-delete-btn-${name}`));
      return screen.getByRole('dialog');
    };

    it('deletes after confirmation and removes the row', async () => {
      renderClient();
      const dialog = askDelete();
      expect(within(dialog).getByText(L.confirmDeleteTitle)).toBeTruthy();
      expect(within(dialog).getByText(L.confirmDeleteDescription.replace('{name}', 'Travel'))).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: L.delete }));
      expect(deleteMutate).toHaveBeenCalledWith('l2', expect.any(Object));
      act(() => lastCallbacks(deleteMutate).onSuccess!({ data: {} }));
      expect(toastSuccess).toHaveBeenCalledWith(L.labelDeletedSuccessfully);
      await waitFor(() => expect(screen.queryByText('Travel')).toBeNull());
    });

    it('does not delete when the confirmation is dismissed', async () => {
      renderClient();
      const dialog = askDelete();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(deleteMutate).not.toHaveBeenCalled();
      expect(screen.getByText('Travel')).toBeTruthy();
    });

    it('ignores a label without an id', () => {
      renderClient();
      const dialog = askDelete('NoId');
      fireEvent.click(within(dialog).getByRole('button', { name: L.delete }));
      expect(deleteMutate).not.toHaveBeenCalled();
    });

    it('shows an error and keeps the row when delete fails', () => {
      renderClient();
      const dialog = askDelete();
      fireEvent.click(within(dialog).getByRole('button', { name: L.delete }));
      act(() => lastCallbacks(deleteMutate).onError!(new Error('In use')));
      expect(toastError).toHaveBeenCalledWith('In use');
      act(() => lastCallbacks(deleteMutate).onError!(null));
      expect(toastError).toHaveBeenCalledWith(L.failedToDeleteLabel);
      expect(screen.getByText('Travel')).toBeTruthy();
    });
  });
});
