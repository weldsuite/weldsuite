import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as { action: 'open' | 'download' } | undefined,
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useParcelFile: () => ({ mutate: state.mutate, isPending: state.isPending, variables: state.variables }),
}));

import { ParcelFileButtons } from './parcel-file-buttons';

const t = en.weldstash.shipping.labels;

beforeEach(() => {
  state.mutate.mockReset();
  state.toastError.mockReset();
  state.isPending = false;
  state.variables = undefined;
});

describe('ParcelFileButtons', () => {
  it('opens a PDF label for printing and downloads it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ParcelFileButtons parcelId="par_1" kind="label" format="pdf" subject="Label 1" fileName="label-3S1" />);
    await user.click(screen.getByRole('button', { name: `${t.print} Label 1` }));
    expect(state.mutate).toHaveBeenLastCalledWith(
      { id: 'par_1', kind: 'label', action: 'open', format: 'pdf', fileName: 'label-3S1' },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    await user.click(screen.getByRole('button', { name: `${t.download} Label 1` }));
    expect(state.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'download' }), expect.anything());
  });

  it('offers only Download for a ZPL label', () => {
    renderWithProviders(<ParcelFileButtons parcelId="par_1" kind="label" format="zpl" subject="Label 1" />);
    expect(screen.queryByRole('button', { name: new RegExp(t.print) })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(t.download) })).toBeInTheDocument();
  });

  it('still offers Print for a customs document', () => {
    renderWithProviders(<ParcelFileButtons parcelId="par_1" kind="customs" format="zpl" subject="Customs" />);
    expect(screen.getByRole('button', { name: new RegExp(t.print) })).toBeInTheDocument();
  });

  it('disables both buttons while a file is being fetched', () => {
    state.isPending = true;
    state.variables = { action: 'open' };
    renderWithProviders(<ParcelFileButtons parcelId="par_1" kind="label" subject="Label 1" />);
    expect(screen.getByRole('button', { name: new RegExp(t.print) })).toBeDisabled();
    expect(screen.getByRole('button', { name: new RegExp(t.download) })).toBeDisabled();
  });

  it('disables both buttons while a download runs', () => {
    state.isPending = true;
    state.variables = { action: 'download' };
    renderWithProviders(<ParcelFileButtons parcelId="par_1" kind="label" subject="Label 1" />);
    expect(screen.getByRole('button', { name: new RegExp(t.print) })).toBeDisabled();
    expect(screen.getByRole('button', { name: new RegExp(t.download) })).toBeDisabled();
  });

  it('toasts the error message, or the generic line when it has none', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ParcelFileButtons parcelId="par_1" kind="label" subject="Label 1" />);
    await user.click(screen.getByRole('button', { name: new RegExp(t.download) }));
    const options = state.mutate.mock.calls[0]?.[1] as { onError: (err: Error) => void };
    options.onError(new Error('Not found'));
    expect(state.toastError).toHaveBeenLastCalledWith('Not found');
    options.onError(new Error(''));
    expect(state.toastError).toHaveBeenLastCalledWith(t.downloadFailed);
  });
});
