import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { CarrierAccount, CarrierCatalogEntry } from '@weldsuite/app-api-client/schemas/shipping';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  createPending: false,
  updatePending: false,
  createError: null as unknown,
  updateError: null as unknown,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useCreateCarrier: () => ({ mutateAsync: state.create, isPending: state.createPending, error: state.createError }),
  useUpdateCarrier: () => ({ mutateAsync: state.update, isPending: state.updatePending, error: state.updateError }),
}));

import { CarrierDialog } from './carrier-dialog';

const ts = en.weldstash.shipping;
const t = ts.carriers.dialog;

const postnl: CarrierCatalogEntry = {
  code: 'postnl',
  name: 'PostNL',
  website: 'https://postnl.nl',
  credentialFields: [
    { key: 'apiKey', secret: true, required: true },
    { key: 'customerCode', secret: false, required: true },
    { key: 'collectionLocation', secret: false, required: false },
  ],
  multiCollo: true,
  servicePoints: true,
  returnLabels: true,
  customs: true,
  labelFormats: ['pdf_a6', 'zpl'],
  weldsuiteContract: true,
};

const dhl: CarrierCatalogEntry = {
  code: 'dhl_parcel_nl',
  name: 'DHL Parcel',
  website: 'https://dhlparcel.nl',
  credentialFields: [{ key: 'userId', secret: false, required: true }],
  multiCollo: true,
  servicePoints: true,
  returnLabels: true,
  customs: false,
  labelFormats: ['pdf_a4'],
  weldsuiteContract: false,
};

function carrier(over: Partial<CarrierAccount> = {}): CarrierAccount {
  return {
    id: 'car_1',
    name: 'PostNL main',
    code: 'postnl',
    carrierName: 'PostNL',
    contract: 'own',
    isDefault: true,
    isActive: true,
    accountNumber: null,
    settings: { sandbox: true, labelFormat: 'zpl', senderAddress: { name: 'Warehouse', street: 'Dock', city: 'Utrecht' } },
    credentials: { apiKey: '••••abcd', customerCode: 'ABC' },
    hasCredentials: true,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

function renderDialog(props: Partial<Parameters<typeof CarrierDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  renderWithProviders(<CarrierDialog open onOpenChange={onOpenChange} catalog={[postnl, dhl]} {...props} />);
  return { onOpenChange };
}

/** Labels of required fields end in an aria-hidden asterisk, so match on the start. */
const field = (label: string) => screen.getByLabelText((content) => content.startsWith(label));

beforeEach(() => {
  polyfillRadixSelect();
  state.create.mockReset().mockResolvedValue({});
  state.update.mockReset().mockResolvedValue({});
  state.createPending = false;
  state.updatePending = false;
  state.createError = null;
  state.updateError = null;
  vi.mocked(toast.success).mockClear();
});

describe('CarrierDialog: connecting', () => {
  it('shows the first catalog carrier with its credential fields and marks the optional one', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: t.createTitle })).toBeInTheDocument();
    expect(field(ts.credentialFields.apiKey)).toHaveAttribute('type', 'password');
    expect(field(ts.credentialFields.customerCode)).toHaveAttribute('type', 'text');
    expect(field(`${ts.credentialFields.collectionLocation} (${t.optional})`)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: new RegExp(t.contractOwn) })).toBeChecked();
  });

  it('blocks the submit and flags the required credentials that are empty', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(field(ts.credentialFields.apiKey), 'secret');
    await user.click(screen.getByRole('button', { name: t.save }));
    expect(await screen.findAllByText(t.required)).toHaveLength(1);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('creates the account with the credentials, defaults and the carrier\'s first label format', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.type(field(ts.credentialFields.apiKey), ' key-123 ');
    await user.type(field(ts.credentialFields.customerCode), 'CC1');
    await user.type(field(t.name), 'Main shop');
    await user.click(screen.getByRole('button', { name: t.save }));

    await vi.waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create).toHaveBeenCalledWith({
      code: 'postnl',
      name: 'Main shop',
      contract: 'own',
      credentials: { apiKey: 'key-123', customerCode: 'CC1' },
      settings: { sandbox: false, labelFormat: 'pdf_a6', senderAddress: null, returnAddress: null },
      isDefault: false,
      isActive: true,
      skipTest: undefined,
    });
    expect(toast.success).toHaveBeenCalledWith(ts.carriers.saved);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends the sandbox, default and sender address choices', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(field(ts.credentialFields.apiKey), 'k');
    await user.type(field(ts.credentialFields.customerCode), 'c');
    await user.click(screen.getByRole('switch', { name: t.sandbox }));
    await user.click(screen.getByRole('switch', { name: t.makeDefault }));
    await user.click(screen.getByRole('button', { name: new RegExp(t.senderAddress) }));
    expect(screen.getByText(t.addressHint)).toBeInTheDocument();
    const [senderStreet] = screen.getAllByLabelText(ts.address.street);
    await user.type(senderStreet!, 'Dock');
    await user.click(screen.getByRole('button', { name: t.save }));

    await vi.waitFor(() => expect(state.create).toHaveBeenCalled());
    const input = state.create.mock.calls[0]![0] as {
      isDefault: boolean;
      settings: { sandbox: boolean; senderAddress: { street: string; line1: string } | null; returnAddress: unknown };
    };
    expect(input.isDefault).toBe(true);
    expect(input.settings.sandbox).toBe(true);
    expect(input.settings.senderAddress).toMatchObject({ street: 'Dock', line1: 'Dock' });
    expect(input.settings.returnAddress).toBeNull();
  });

  it('drops the credential fields and sends none on WeldSuite\'s contract', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('radio', { name: new RegExp(t.contractWeldsuite) }));
    expect(screen.queryByLabelText(ts.credentialFields.apiKey)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.save }));
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0]![0]).toMatchObject({ code: 'postnl', contract: 'weldsuite', credentials: undefined });
  });

  it('offers no contract choice for a carrier without WeldSuite\'s contract, and switches the label format with the carrier', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getAllByRole('combobox')[0]!);
    await user.click(await screen.findByRole('option', { name: 'DHL Parcel' }));
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await user.type(field(ts.credentialFields.userId), 'user-1');
    await user.click(screen.getByRole('button', { name: t.save }));
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0]![0]).toMatchObject({
      code: 'dhl_parcel_nl',
      credentials: { userId: 'user-1' },
      settings: { labelFormat: 'pdf_a4' },
    });
  });

  it('stays open and sends nothing more when the save fails', async () => {
    const user = userEvent.setup();
    state.create.mockRejectedValue(new Error('rejected'));
    const { onOpenChange } = renderDialog();
    await user.type(field(ts.credentialFields.apiKey), 'k');
    await user.type(field(ts.credentialFields.customerCode), 'c');
    await user.click(screen.getByRole('button', { name: t.save }));
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes from Cancel', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: ts.labels.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the error notice and lets the user save without the test when the carrier is unreachable', async () => {
    const user = userEvent.setup();
    state.createError = new ApiError('x', 502, { error: { code: 'CARRIER_UNAVAILABLE', message: 'down', details: { messages: ['Timeout at PostNL'] } } });
    const { onOpenChange } = renderDialog();
    expect(screen.getByText(t.errorTitle)).toBeInTheDocument();
    expect(screen.getByText('Timeout at PostNL')).toBeInTheDocument();
    await user.type(field(ts.credentialFields.apiKey), 'k');
    await user.type(field(ts.credentialFields.customerCode), 'c');
    await user.click(screen.getByRole('button', { name: t.saveWithoutTest }));
    await vi.waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0]![0]).toMatchObject({ skipTest: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers no save-without-test for other errors', () => {
    state.createError = new ApiError('x', 400, { error: { code: 'CARRIER_UNAUTHORIZED', message: 'bad' } });
    renderDialog();
    expect(screen.getByText(ts.errors.CARRIER_UNAUTHORIZED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.saveWithoutTest })).not.toBeInTheDocument();
  });

  it('disables Save and shows the saving label while a call is pending', () => {
    state.createPending = true;
    renderDialog();
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
  });
});

describe('CarrierDialog: editing', () => {
  it('fills the form from the account, locks the carrier and never shows the saved secret', () => {
    renderDialog({ carrier: carrier() });
    expect(screen.getByRole('heading', { name: t.editTitle })).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')[0]).toBeDisabled();
    expect(field(t.name)).toHaveValue('PostNL main');
    const secret = field(ts.credentialFields.apiKey);
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('placeholder', '••••abcd');
    expect(screen.getByText(t.keepSecretHint)).toBeInTheDocument();
    expect(field(ts.credentialFields.customerCode)).toHaveValue('ABC');
    expect(screen.getByRole('switch', { name: t.sandbox })).toBeChecked();
  });

  it('keeps the saved secret when left empty and updates the account', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ carrier: carrier() });
    await user.click(screen.getByRole('button', { name: t.save }));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.create).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenCalledWith({
      id: 'car_1',
      data: {
        name: 'PostNL main',
        contract: 'own',
        credentials: { customerCode: 'ABC' },
        settings: {
          sandbox: true,
          labelFormat: 'zpl',
          senderAddress: expect.objectContaining({ name: 'Warehouse', street: 'Dock', city: 'Utrecht' }),
          returnAddress: null,
        },
        isDefault: true,
        isActive: true,
        skipTest: undefined,
      },
    });
    expect(toast.success).toHaveBeenCalledWith(ts.carriers.saved);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends a new secret and ignores a value that is still the mask', async () => {
    const user = userEvent.setup();
    renderDialog({ carrier: carrier() });
    await user.type(field(ts.credentialFields.apiKey), 'new-secret');
    await user.click(screen.getByRole('button', { name: t.save }));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(state.update.mock.calls[0]![0].data.credentials).toEqual({ apiKey: 'new-secret', customerCode: 'ABC' });
  });

  it('still requires a non-secret credential that was cleared', async () => {
    const user = userEvent.setup();
    renderDialog({ carrier: carrier() });
    await user.clear(field(ts.credentialFields.customerCode));
    await user.click(screen.getByRole('button', { name: t.save }));
    expect(await screen.findByText(t.required)).toBeInTheDocument();
    expect(state.update).not.toHaveBeenCalled();
  });

  it('shows the update error and the saving state from the update call', () => {
    state.updateError = new ApiError('x', 502, { error: { code: 'CARRIER_UNAVAILABLE', message: 'down' } });
    state.updatePending = true;
    renderDialog({ carrier: carrier() });
    expect(screen.getByText(t.errorTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.saveWithoutTest })).toBeDisabled();
  });

  it('edits an account on WeldSuite\'s contract without credential fields', async () => {
    const user = userEvent.setup();
    renderDialog({ carrier: carrier({ contract: 'weldsuite', credentials: {}, hasCredentials: false, settings: {} }) });
    expect(screen.queryByLabelText(ts.credentialFields.apiKey)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.save }));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(state.update.mock.calls[0]![0].data).toMatchObject({ contract: 'weldsuite', credentials: undefined });
  });
});
