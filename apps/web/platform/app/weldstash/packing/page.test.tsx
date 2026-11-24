import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { WeldstashPickList } from '@/hooks/queries/use-weldstash-queries';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  stashShipping: true,
  completed: [] as unknown[],
  packed: [] as unknown[],
  open: vi.fn(),
  pack: vi.fn(),
  printSlip: vi.fn(),
  ship: { mutateAsync: vi.fn(), isPending: false },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => feature === 'stash-shipping' && env.stashShipping,
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: env.open }),
  useObjectPanelUrlSync: () => undefined,
}));
vi.mock('@/components/panel-entity-list', () => import('@/components/panel-entity-list-test-mock'));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useInfiniteWeldstashPickLists: ({ status }: { status: string }) => ({
    data: { pages: [{ data: status === 'completed' ? env.completed : env.packed }] },
    isLoading: false,
  }),
  usePackWeldstashPickList: () => ({ mutate: env.pack }),
  usePrintPackingSlip: () => ({ mutate: env.printSlip }),
  useShipWeldstashPickList: () => env.ship,
}));
vi.mock('../shipping/components/create-labels-dialog', () => ({
  CreateLabelsDialog: ({ pickListId, onOpenChange }: { pickListId: string; onOpenChange: (open: boolean) => void }) => (
    <div role="dialog" aria-label="labels">
      {`labels for ${pickListId}`}
      <button type="button" onClick={() => onOpenChange(true)}>
        stay open
      </button>
      <button type="button" onClick={() => onOpenChange(false)}>
        close labels
      </button>
    </div>
  ),
}));

import WeldStashPackingPage from './page';

const tl = en.weldstash.shipping.labels;

function list(id: string, status: 'completed' | 'packed'): WeldstashPickList {
  return { id, pickListNumber: `PL-${id}`, status, orderIds: [], items: [] } as unknown as WeldstashPickList;
}

beforeEach(() => {
  env.allowed = new Set(['weldstash:parcels:create']);
  env.stashShipping = true;
  env.completed = [list('c1', 'completed')];
  env.packed = [list('p1', 'packed')];
  env.open.mockReset();
  env.pack.mockReset();
  env.printSlip.mockReset();
  env.ship = { mutateAsync: vi.fn(), isPending: false };
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('WeldStashPackingPage carrier labels', () => {
  it('offers "Create labels" on packed lists only', () => {
    render(<WeldStashPackingPage />);
    expect(within(screen.getByTestId('row-p1')).getByRole('button', { name: tl.createAction })).toBeInTheDocument();
    expect(within(screen.getByTestId('row-c1')).queryByRole('button', { name: tl.createAction })).not.toBeInTheDocument();
  });

  it('opens the label dialog for that list, and closes it when asked', async () => {
    const user = userEvent.setup();
    render(<WeldStashPackingPage />);
    expect(screen.queryByRole('dialog', { name: 'labels' })).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId('row-p1')).getByRole('button', { name: tl.createAction }));
    expect(screen.getByRole('dialog', { name: 'labels' })).toHaveTextContent('labels for p1');
    expect(env.open).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'stay open' }));
    expect(screen.getByRole('dialog', { name: 'labels' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close labels' }));
    expect(screen.queryByRole('dialog', { name: 'labels' })).not.toBeInTheDocument();
  });

  it('does not offer it without the permission', () => {
    env.allowed = new Set();
    render(<WeldStashPackingPage />);
    expect(screen.queryByRole('button', { name: tl.createAction })).not.toBeInTheDocument();
  });

  it('does not offer it on an edition without carrier shipping', () => {
    env.stashShipping = false;
    render(<WeldStashPackingPage />);
    expect(screen.queryByRole('button', { name: tl.createAction })).not.toBeInTheDocument();
  });
});
