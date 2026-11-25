import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

interface StubPanelProps {
  extras?: ReactNode;
}

const env = vi.hoisted(() => ({
  allowed: new Set<string>(),
  stashShipping: true,
  list: undefined as unknown,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => feature === 'stash-shipping' && env.stashShipping,
}));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useWeldstashPickList: () => ({ data: env.list ? { data: env.list } : undefined, isLoading: false, error: null }),
  useAssignWeldstashPickList: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/app/weldstash/shipping/components/create-labels-dialog', () => ({
  CreateLabelsDialog: ({ pickListId, onOpenChange }: { pickListId: string; onOpenChange: (open: boolean) => void }) => (
    <div role="dialog">
      {`labels for ${pickListId}`}
      <button type="button" onClick={() => onOpenChange(false)}>
        close labels
      </button>
    </div>
  ),
}));
vi.mock('@/components/objects/_shared/simple-object-panel', () => ({
  SectionHeader: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  LineItemList: () => <ul />,
  SimpleObjectPanel: ({ extras }: StubPanelProps) => <div>{extras}</div>,
}));

import { PickListPanel } from './pick-list-panel';

const tl = en.weldstash.shipping;
const props = { id: 'pl_1' } as React.ComponentProps<typeof PickListPanel>;

function setList(status: string) {
  env.list = { id: 'pl_1', pickListNumber: 'PL-1', status, items: [], orderIds: [] };
}

beforeEach(() => {
  env.allowed = new Set(['weldstash:parcels:read']);
  env.stashShipping = true;
  setList('packed');
});

describe('PickListPanel carrier labels', () => {
  it('opens the label dialog of a packed list, and closes it again', async () => {
    const user = userEvent.setup();
    render(<PickListPanel {...props} />);
    expect(screen.getByRole('heading', { name: tl.pickListPanel.title })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: tl.labels.createAction }));
    expect(screen.getByRole('dialog')).toHaveTextContent('labels for pl_1');
    await user.click(screen.getByRole('button', { name: 'close labels' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers to view the labels of a shipped list', () => {
    setList('shipped');
    render(<PickListPanel {...props} />);
    expect(screen.getByRole('button', { name: tl.labels.viewAction })).toBeInTheDocument();
  });

  it.each(['pending', 'assigned', 'completed'])('offers nothing for a %s list', (status) => {
    setList(status);
    render(<PickListPanel {...props} />);
    expect(screen.queryByRole('heading', { name: tl.pickListPanel.title })).not.toBeInTheDocument();
  });

  it('offers nothing without the permission', () => {
    env.allowed = new Set();
    render(<PickListPanel {...props} />);
    expect(screen.queryByRole('heading', { name: tl.pickListPanel.title })).not.toBeInTheDocument();
  });

  it('offers nothing on an edition without carrier shipping', () => {
    env.stashShipping = false;
    render(<PickListPanel {...props} />);
    expect(screen.queryByRole('heading', { name: tl.pickListPanel.title })).not.toBeInTheDocument();
  });
});
