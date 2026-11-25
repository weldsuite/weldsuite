import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { Parcel } from '@weldsuite/app-api-client/schemas/shipping';

interface FilterSelectStubProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: { value: string; label: string }[];
  allLabel: string;
  ariaLabel: string;
}

const env = vi.hoisted(() => ({
  query: '',
  replace: vi.fn(),
  open: vi.fn(),
  urlSync: vi.fn(),
  filters: undefined as unknown,
  result: {
    data: undefined as unknown,
    isLoading: false,
    error: null as Error | null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  },
  onLoadMore: null as null | (() => void),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: env.replace }),
  useSearchParams: () => new URLSearchParams(env.query),
}));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: (value: string) => value }));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelUrlSync: (path: string) => env.urlSync(path),
}));
vi.mock('@/hooks/queries/use-shipping-queries', () => ({
  useInfiniteParcels: (filters: unknown) => {
    env.filters = filters;
    return env.result;
  },
}));
vi.mock('@weldsuite/ui/components/filter-select', () => ({
  FilterSelect: ({ value, onChange, options, allLabel, ariaLabel }: FilterSelectStubProps) => (
    <div role="group" aria-label={ariaLabel} data-value={value ?? ''}>
      <button type="button" onClick={() => onChange(undefined)}>
        {allLabel}
      </button>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@/components/panel-entity-list', async () => {
  const mock = await import('@/components/panel-entity-list-test-mock');
  return {
    PanelEntityList: (props: Parameters<typeof mock.PanelEntityList>[0] & { onLoadMore?: () => void; hasMore?: boolean }) => {
      env.onLoadMore = props.onLoadMore ?? null;
      return (
        <>
          <mock.PanelEntityList {...props} />
          <span data-testid="has-more">{String(props.hasMore)}</span>
        </>
      );
    },
  };
});

import WeldStashShipmentsPage from './page';

const t = en.weldstash.shipping;

function parcel(id: string): Parcel {
  return {
    id,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
    status: 'shipped',
    statusHistory: null,
    trackingNumber: `TRK-${id}`,
    trackingUrl: null,
    carrierName: 'PostNL',
    orderNumber: 'SO-1',
    recipientName: 'Ann',
    recipientCompany: null,
    recipientAddress: null,
    shippedAt: null,
    isReturn: false,
  } as Parcel;
}

function setPages(...pages: { data?: Parcel[] }[]) {
  env.result.data = { pages };
}

beforeEach(() => {
  env.query = '';
  env.replace.mockReset();
  env.open.mockReset();
  env.urlSync.mockReset();
  env.filters = undefined;
  env.result = { data: undefined, isLoading: false, error: null, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() };
});

describe('WeldStashShipmentsPage', () => {
  it('syncs the object panel with the URL and lists the labelled parcels of every page', () => {
    setPages({ data: [parcel('p1')] }, { data: [parcel('p2')] }, {});
    render(<WeldStashShipmentsPage />);
    expect(env.urlSync).toHaveBeenCalledWith('/weldstash/shipments');
    expect(env.filters).toEqual({ labelled: true, limit: 50, status: undefined, search: undefined });
    expect(screen.getByTestId('row-p1')).toBeInTheDocument();
    expect(screen.getByTestId('row-p2')).toBeInTheDocument();
  });

  it('shows the empty state without parcels', () => {
    render(<WeldStashShipmentsPage />);
    expect(screen.getByText(t.shipments.empty)).toBeInTheDocument();
    expect(screen.getByText(t.shipments.emptyDescription)).toBeInTheDocument();
  });

  it('shows the loading and error states', () => {
    env.result.isLoading = true;
    const { unmount } = render(<WeldStashShipmentsPage />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    unmount();
    env.result.isLoading = false;
    env.result.error = new Error('Shipments broke');
    render(<WeldStashShipmentsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('Shipments broke');
  });

  it('opens the parcel panel on a row click', async () => {
    setPages({ data: [parcel('p1')] });
    render(<WeldStashShipmentsPage />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'open p1' }));
    expect(env.open).toHaveBeenCalledWith({ type: 'parcel', id: 'p1' });
  });

  it('reads the search and the status filter from the URL', () => {
    env.query = 'search=%20TRK-9%20&status=delivered';
    render(<WeldStashShipmentsPage />);
    expect(env.filters).toEqual({ labelled: true, limit: 50, status: 'delivered', search: 'TRK-9' });
    expect(screen.getByLabelText('search')).toHaveValue(' TRK-9 ');
    expect(screen.getByRole('group', { name: t.shipments.statusFilter })).toHaveAttribute('data-value', 'delivered');
  });

  it('writes the search to the URL and keeps the other parameters', async () => {
    env.query = 'status=shipped';
    render(<WeldStashShipmentsPage />);
    await userEvent.setup().type(screen.getByLabelText('search'), 'x');
    expect(env.replace).toHaveBeenLastCalledWith('/weldstash/shipments?status=shipped&search=x');
  });

  it('removes the search from the URL when it is cleared', async () => {
    env.query = 'search=a';
    render(<WeldStashShipmentsPage />);
    await userEvent.setup().clear(screen.getByLabelText('search'));
    expect(env.replace).toHaveBeenLastCalledWith('/weldstash/shipments');
  });

  it('offers every status, and writes the choice to the URL', async () => {
    const user = userEvent.setup();
    render(<WeldStashShipmentsPage />);
    const group = screen.getByRole('group', { name: t.shipments.statusFilter });
    expect(group.querySelectorAll('button')).toHaveLength(Object.keys(t.statuses).length + 1);
    await user.click(screen.getByRole('button', { name: t.statuses.delivered }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldstash/shipments?status=delivered');
  });

  it('drops the status from the URL for "all statuses"', async () => {
    env.query = 'status=delivered';
    render(<WeldStashShipmentsPage />);
    await userEvent.setup().click(screen.getByRole('button', { name: t.shipments.allStatuses }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldstash/shipments');
  });

  describe('paging', () => {
    it('loads the next page when there is one', () => {
      env.result.hasNextPage = true;
      render(<WeldStashShipmentsPage />);
      expect(screen.getByTestId('has-more')).toHaveTextContent('true');
      env.onLoadMore?.();
      expect(env.result.fetchNextPage).toHaveBeenCalledTimes(1);
    });

    it('does not load while a page is on its way, or when there is no more', () => {
      env.result.hasNextPage = true;
      env.result.isFetchingNextPage = true;
      const { unmount } = render(<WeldStashShipmentsPage />);
      env.onLoadMore?.();
      unmount();
      env.result.hasNextPage = false;
      env.result.isFetchingNextPage = false;
      render(<WeldStashShipmentsPage />);
      env.onLoadMore?.();
      expect(env.result.fetchNextPage).not.toHaveBeenCalled();
    });
  });
});
