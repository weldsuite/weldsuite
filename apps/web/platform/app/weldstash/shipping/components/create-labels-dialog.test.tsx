import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { CarrierAccount, CreateLabelsResult, Parcel, PickListShipping } from '@weldsuite/app-api-client/schemas/shipping';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  shipping: undefined as unknown,
  shippingLoading: false,
  shippingError: null as Error | null,
  shippingRefetch: vi.fn(),
  carriers: [] as unknown[],
  carriersLoading: false,
  carriersError: null as Error | null,
  carriersRefetch: vi.fn(),
  enabled: [] as boolean[],
  formProps: null as unknown,
  resultProps: null as unknown,
}));

vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  usePickListShipping: (_id: string, enabled: boolean) => {
    state.enabled.push(enabled);
    return {
      data: state.shipping,
      isLoading: state.shippingLoading,
      isError: state.shippingError !== null,
      error: state.shippingError,
      refetch: state.shippingRefetch,
    } satisfies QueryState<unknown>;
  },
  useCarriers: () => ({
    data: state.carriers,
    isLoading: state.carriersLoading,
    isError: state.carriersError !== null,
    error: state.carriersError,
    refetch: state.carriersRefetch,
  }),
}));

vi.mock('./labels-form', () => ({
  LabelsForm: (props: { shipping: PickListShipping; carriers: CarrierAccount[]; onCreated: (r: CreateLabelsResult) => void; onCancel: () => void }) => {
    state.formProps = props;
    return (
      <div data-testid="labels-form">
        <button type="button" onClick={() => props.onCreated(created)}>
          form created
        </button>
        <button type="button" onClick={props.onCancel}>
          form cancel
        </button>
      </div>
    );
  },
}));

vi.mock('./labels-result', () => ({
  LabelsResult: (props: { shipping: PickListShipping; created: CreateLabelsResult | null; onVoided: () => void; onClose: () => void }) => {
    state.resultProps = props;
    return (
      <div data-testid="labels-result">
        <button type="button" onClick={props.onVoided}>
          result voided
        </button>
        <button type="button" onClick={props.onClose}>
          result close
        </button>
      </div>
    );
  },
}));

import { CreateLabelsDialog } from './create-labels-dialog';

const t = en.weldstash.shipping.labels;

function parcel(id: string, status: Parcel['status']): Parcel {
  return { id, status } as Parcel;
}

const created: CreateLabelsResult = { pickListId: 'pl_1', parcels: [parcel('par_new', 'label_created')], returnParcel: null, warnings: [], credits: null };

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
    defaultCarrierId: null,
    parcels: [],
    ...over,
  };
}

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  renderWithProviders(<CreateLabelsDialog pickListId="pl_1" open={open} onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

beforeEach(() => {
  state.shipping = shipping();
  state.shippingLoading = false;
  state.shippingError = null;
  state.shippingRefetch.mockReset();
  state.carriers = [];
  state.carriersLoading = false;
  state.carriersError = null;
  state.carriersRefetch.mockReset();
  state.enabled = [];
  state.formProps = null;
  state.resultProps = null;
});

describe('CreateLabelsDialog', () => {
  it('shows a loader while the shipping details or the carriers load', () => {
    state.shippingLoading = true;
    renderDialog();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByTestId('labels-form')).not.toBeInTheDocument();
  });

  it('shows a loader while only the carriers load', () => {
    state.carriersLoading = true;
    renderDialog();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows the error with the server message and refetches both queries on retry', async () => {
    const user = userEvent.setup();
    state.shipping = undefined;
    state.shippingError = new Error('Pick list not found');
    renderDialog();
    expect(screen.getByText('Pick list not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(state.shippingRefetch).toHaveBeenCalled();
    expect(state.carriersRefetch).toHaveBeenCalled();
  });

  it('shows the carriers error, and the generic line when it has no message', () => {
    state.carriersError = new Error('');
    renderDialog();
    expect(screen.getByText(t.loadError)).toBeInTheDocument();
  });

  it('shows the generic error when there is no data and no error', () => {
    state.shipping = undefined;
    renderDialog();
    expect(screen.getByText(t.loadError)).toBeInTheDocument();
  });

  it('shows the form with the order number in the title when the list has no labels', () => {
    state.carriers = [{ id: 'car_1' }];
    renderDialog();
    expect(screen.getByRole('heading', { name: t.title.replace('{order}', 'SO-1') })).toBeInTheDocument();
    expect(screen.getByTestId('labels-form')).toBeInTheDocument();
    expect((state.formProps as { carriers: unknown[] }).carriers).toEqual([{ id: 'car_1' }]);
  });

  it('uses the plain title for a pick list without an order', () => {
    state.shipping = shipping({ orderNumber: null });
    renderDialog();
    expect(screen.getByRole('heading', { name: t.titleNoOrder })).toBeInTheDocument();
  });

  it('closes from the form', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'form cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the labels the pick list already has, without its cancelled parcels', () => {
    state.shipping = shipping({ parcels: [parcel('par_1', 'label_created'), parcel('par_old', 'cancelled')] });
    renderDialog();
    expect(screen.getByTestId('labels-result')).toBeInTheDocument();
    expect(screen.queryByTestId('labels-form')).not.toBeInTheDocument();
    expect((state.resultProps as { shipping: PickListShipping }).shipping.parcels.map((p) => p.id)).toEqual(['par_1']);
  });

  it('shows the form when every parcel was voided', () => {
    state.shipping = shipping({ parcels: [parcel('par_old', 'cancelled')] });
    renderDialog();
    expect(screen.getByTestId('labels-form')).toBeInTheDocument();
  });

  it('switches to the result after labels are created and back to a fresh form after a void', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'form created' }));
    expect(screen.getByTestId('labels-result')).toBeInTheDocument();
    expect((state.resultProps as { created: CreateLabelsResult | null }).created).toEqual(created);
    await user.click(screen.getByRole('button', { name: 'result voided' }));
    expect(screen.getByTestId('labels-form')).toBeInTheDocument();
  });

  it('closes from the result', async () => {
    const user = userEvent.setup();
    state.shipping = shipping({ parcels: [parcel('par_1', 'label_created')] });
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'result close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('only loads while it is open', () => {
    renderDialog(false);
    expect(state.enabled).toEqual([false]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
