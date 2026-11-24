import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { CreateLabelsResult, Parcel, PickListShipping } from '@weldsuite/app-api-client/schemas/shipping';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  permissions: new Set<string>(),
  voidAsync: vi.fn(),
  voidPending: false,
  shipMutate: vi.fn(),
  shipPending: false,
  shipError: null as unknown,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: state.toastSuccess, error: state.toastError } }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (p: string) => state.permissions.has(p) }) }));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useVoidLabels: () => ({ mutateAsync: state.voidAsync, isPending: state.voidPending }),
  useParcelFile: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useShipWeldstashPickList: () => ({
    mutate: state.shipMutate,
    isPending: state.shipPending,
    isError: state.shipError !== null,
    error: state.shipError,
  }),
}));

import { LabelsResult } from './labels-result';

const t = en.weldstash.shipping.labels;

function parcel(over: Partial<Parcel> = {}): Parcel {
  return {
    id: 'par_1',
    createdAt: '2026-11-24T10:00:00Z',
    updatedAt: '2026-11-24T10:00:00Z',
    status: 'label_created',
    statusHistory: null,
    trackingNumber: '3SABCD1234567',
    trackingUrl: 'https://track.example.com/3SABCD1234567',
    carrierId: 'car_1',
    carrierName: 'PostNL',
    carrierCode: 'postnl',
    serviceType: 'parcel',
    carrierReference: null,
    colloNumber: 1,
    pickListId: 'pl_1',
    shipmentId: null,
    orderId: 'ord_1',
    orderNumber: 'SO-1',
    referenceNumber: null,
    recipientName: 'Jan Jansen',
    recipientCompany: null,
    recipientEmail: null,
    recipientPhone: null,
    recipientAddress: null,
    senderName: null,
    senderCompany: null,
    senderAddress: null,
    weight: '1.25',
    dimensions: null,
    servicePoint: null,
    shippingCost: null,
    labelUrl: 'https://files.example.com/label.pdf',
    labelFormat: 'pdf',
    customsFormUrl: null,
    customsInfo: null,
    isReturn: false,
    returnForParcelId: null,
    returnTrackingNumber: null,
    returnLabelUrl: null,
    shippedAt: null,
    estimatedDeliveryDate: null,
    actualDeliveryDate: null,
    lastScanDate: null,
    lastScanLocation: null,
    trackingNextCheckAt: null,
    ...over,
  };
}

function shipping(over: Partial<PickListShipping> = {}): PickListShipping {
  return {
    pickListId: 'pl_1',
    status: 'packed',
    orderId: 'ord_1',
    orderNumber: 'SO-1',
    recipient: {},
    sender: {},
    suggestedWeightGrams: null,
    customsRequired: false,
    customs: { content: 'sale_of_goods', invoiceNumber: null, currency: 'EUR', lines: [] },
    servicePoint: null,
    defaultCarrierId: 'car_1',
    parcels: [parcel()],
    ...over,
  };
}

function renderResult(props: { shipping?: PickListShipping; created?: CreateLabelsResult | null } = {}) {
  const onVoided = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <LabelsResult pickListId="pl_1" shipping={props.shipping ?? shipping()} created={props.created ?? null} onVoided={onVoided} onClose={onClose} />,
  );
  return { onVoided, onClose };
}

beforeEach(() => {
  state.permissions = new Set(['weldstash:parcels:update']);
  state.voidAsync.mockReset().mockResolvedValue({ pickListId: 'pl_1', voided: 1, parcelId: null });
  state.voidPending = false;
  state.shipMutate.mockReset();
  state.shipPending = false;
  state.shipError = null;
  state.toastSuccess.mockReset();
  state.toastError.mockReset();
});

describe('LabelsResult', () => {
  it('lists the parcels of the pick list with tracking link, status and file buttons', () => {
    renderResult();
    expect(screen.getByText(/^Labels$/)).toBeInTheDocument();
    expect(screen.getByText(`(${t.resultCount.replace('{count}', '1')})`)).toBeInTheDocument();
    expect(screen.getAllByText(t.piece.replace('{number}', '1')).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '3SABCD1234567' })).toHaveAttribute('href', 'https://track.example.com/3SABCD1234567');
    expect(screen.getByText(en.weldstash.shipping.statuses.label_created)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`^${t.print}`) })).toBeInTheDocument();
  });

  it('shows a tracking number without a link, and a dash without a tracking number', () => {
    renderResult({
      shipping: shipping({
        parcels: [
          parcel({ id: 'par_a', trackingUrl: null, colloNumber: 1 }),
          parcel({ id: 'par_b', trackingNumber: null, trackingUrl: null, colloNumber: 2 }),
        ],
      }),
    });
    expect(screen.getByText('3SABCD1234567')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('hides the file buttons of a draft parcel without a label', () => {
    renderResult({ shipping: shipping({ parcels: [parcel({ status: 'draft', labelUrl: null })] }) });
    expect(screen.queryByRole('button', { name: new RegExp(t.print) })).not.toBeInTheDocument();
  });

  it('shows the return label, the customs document, the warnings and the charge of a fresh result', () => {
    const created: CreateLabelsResult = {
      pickListId: 'pl_1',
      parcels: [parcel({ customsFormUrl: 'https://files.example.com/customs.pdf' })],
      returnParcel: parcel({ id: 'par_ret', isReturn: true, trackingNumber: '3SRETURN', trackingUrl: null, customsFormUrl: 'https://files.example.com/c2.pdf' }),
      warnings: ['Weight was rounded', 'Address was corrected'],
      credits: 4.5,
    };
    renderResult({ created });
    expect(screen.getAllByText(t.returnLabelResult).length).toBeGreaterThan(0);
    expect(screen.getByText('3SRETURN')).toBeInTheDocument();
    // The outbound parcel has a customs document; the return label does not.
    expect(screen.getAllByText(t.customsDocument)).toHaveLength(1);
    expect(screen.getByText(t.warnings)).toBeInTheDocument();
    expect(screen.getByText('Weight was rounded')).toBeInTheDocument();
    expect(screen.getByText('Address was corrected')).toBeInTheDocument();
    expect(screen.getByText(t.credits.replace('{credits}', new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(4.5)))).toBeInTheDocument();
  });

  it('shows no charge line when the contract is the user\'s own', () => {
    renderResult({ created: { pickListId: 'pl_1', parcels: [parcel()], returnParcel: null, warnings: [], credits: null } });
    expect(screen.queryByText(/^Charged:/)).not.toBeInTheDocument();
    expect(screen.queryByText(t.warnings)).not.toBeInTheDocument();
  });

  it('closes the dialog', async () => {
    const user = userEvent.setup();
    const { onClose } = renderResult();
    await user.click(screen.getByRole('button', { name: t.close }));
    expect(onClose).toHaveBeenCalled();
  });

  it('marks the pick list as shipped and closes on success', async () => {
    const user = userEvent.setup();
    const { onClose } = renderResult();
    await user.click(screen.getByRole('button', { name: t.markShipped }));
    expect(state.shipMutate).toHaveBeenCalledWith('pl_1', expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }));
    const options = state.shipMutate.mock.calls[0]?.[1] as { onSuccess: () => void; onError: (err: Error) => void };
    options.onSuccess();
    expect(state.toastSuccess).toHaveBeenCalledWith(t.shipped);
    expect(onClose).toHaveBeenCalled();
    options.onError(new Error('Not packed'));
    expect(state.toastError).toHaveBeenLastCalledWith('Not packed');
    options.onError(new Error(''));
    expect(state.toastError).toHaveBeenLastCalledWith(t.shipFailed);
  });

  it('shows why marking as shipped failed', () => {
    state.shipError = new ApiError('Conflict', 409, { error: { code: 'INVALID_STATUS', message: 'Conflict' } });
    renderResult();
    expect(screen.getByText(en.weldstash.shipping.errors.INVALID_STATUS)).toBeInTheDocument();
  });

  it('disables Mark as shipped while it runs', () => {
    state.shipPending = true;
    renderResult();
    expect(screen.getByRole('button', { name: new RegExp(t.markShipped) })).toBeDisabled();
  });

  it('asks for confirmation before voiding, then voids and starts the form again', async () => {
    const user = userEvent.setup();
    const { onVoided } = renderResult();
    await user.click(screen.getByRole('button', { name: t.voidAction }));
    expect(await screen.findByText(t.voidTitle)).toBeInTheDocument();
    expect(state.voidAsync).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: t.voidAction });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(state.voidAsync).toHaveBeenCalledWith('pl_1'));
    await waitFor(() => expect(onVoided).toHaveBeenCalled());
    expect(state.toastSuccess).toHaveBeenCalledWith(t.voided);
  });

  it('toasts when voiding fails and keeps the labels', async () => {
    const user = userEvent.setup();
    state.voidAsync.mockRejectedValueOnce(new Error('Carrier refused'));
    const { onVoided } = renderResult();
    await user.click(screen.getByRole('button', { name: t.voidAction }));
    const buttons = await screen.findAllByRole('button', { name: t.voidAction });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Carrier refused'));
    expect(onVoided).not.toHaveBeenCalled();
  });

  it('uses the generic line when the void error has no message', async () => {
    const user = userEvent.setup();
    state.voidAsync.mockRejectedValueOnce(new Error(''));
    renderResult();
    await user.click(screen.getByRole('button', { name: t.voidAction }));
    const buttons = await screen.findAllByRole('button', { name: t.voidAction });
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith(t.voidFailed));
  });

  it('cannot void or ship a shipped pick list, and says so', () => {
    renderResult({ shipping: shipping({ status: 'shipped' }) });
    expect(screen.getByText(t.alreadyShipped)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.voidAction })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.markShipped })).not.toBeInTheDocument();
  });

  it('hides void and ship without the parcels:update permission', () => {
    state.permissions = new Set();
    renderResult();
    expect(screen.queryByRole('button', { name: t.voidAction })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t.markShipped })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.close })).toBeInTheDocument();
  });
});
