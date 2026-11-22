import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  members: [] as Array<Record<string, string>>,
  dms: [] as Array<{ otherMembers: Array<{ userId: string }>; lastMessageAt: string | null }>,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: state.members }, isLoading: false }),
  useDmChannels: () => ({ data: { data: state.dms } }),
}));
vi.mock('@/contexts/presence-context', () => ({ usePresence: () => ({ presenceMap: {} }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: (value: string) => value }));
vi.mock('@weldsuite/ui/components/status-dot', () => ({ StatusDot: () => null }));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/i18n', () => ({
  getTranslations: () => ({
    directories: 'Directories',
    dmCreate: { invited: 'Invited', invitedHint: 'Can be messaged once they accept the invitation' },
    messageInput: { sendMessage: 'Send message' },
    directoriesPage: { nameHeader: 'Name', emailHeader: 'Email', lastActivityHeader: 'Last activity', statusActive: 'Active' },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The list shell is not what this page decides; render its rows directly, and
// a stand-in for its Filter that sets the Status pill.
vi.mock('@/components/entity-list', () => ({
  EntityList: ({
    items,
    renderRow,
    onFiltersChange,
  }: {
    items: unknown[];
    renderRow: (item: unknown) => ReactNode;
    onFiltersChange: (filters: Array<{ id: string; field: string; operator: string; value: string }>) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onFiltersChange([{ id: 'f1', field: 'status', operator: 'is', value: 'invited' }])}>
        only invited
      </button>
      <button type="button" onClick={() => onFiltersChange([{ id: 'f1', field: 'status', operator: 'is not', value: 'invited' }])}>
        not invited
      </button>
      {items.map(renderRow)}
    </div>
  ),
  EmptyStateIllustration: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import DirectoriesPage from './page';

beforeEach(() => {
  state.navigate.mockReset();
  state.members = [
    { id: 'mbr_ann', userId: 'user_ann', name: 'Ann', email: 'ann@example.com', status: 'ACTIVE' },
    { id: 'mbr_bob', userId: 'invited_bob@example.com', name: 'Bob', email: 'bob@example.com', status: 'PENDING' },
  ];
  state.dms = [];
});

const row = (name: string) => screen.getByText(name).closest<HTMLElement>('[data-testid="directory-row"]')!;
const names = () => screen.queryAllByTestId('directory-row').map((r) => r.querySelector('.font-medium')?.textContent);

describe('WeldChat directory', () => {
  it('opens the DM with someone who joined from anywhere on the row', () => {
    render(<DirectoriesPage />);
    fireEvent.click(within(row('Ann')).getByRole('button', { name: 'Ann' }));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/dm/$userId', params: { userId: 'user_ann' } });
  });

  it("shows an invitee as Invited, on a row that doesn't open anything", () => {
    render(<DirectoriesPage />);
    const bob = row('Bob');
    expect(within(bob).queryByRole('button', { name: 'Bob' })).toBeNull();
    expect(bob.getAttribute('title')).toBe('Can be messaged once they accept the invitation');
    expect(bob.textContent).toContain('Invited');
    fireEvent.click(screen.getByText('Bob'));
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('tells two people with the same name apart by their address, in its own column', () => {
    state.members = [
      { id: 'mbr_a', userId: 'user_a', name: 'Sam', email: 'sam@one.example', status: 'ACTIVE' },
      { id: 'mbr_b', userId: 'user_b', name: 'Sam', email: 'sam@two.example', status: 'ACTIVE' },
    ];
    render(<DirectoriesPage />);
    expect(screen.getByText('sam@one.example')).toBeTruthy();
    expect(screen.getByText('sam@two.example')).toBeTruthy();
  });

  it('shows the last message in the DM as last activity', () => {
    state.dms = [{ otherMembers: [{ userId: 'user_ann' }], lastMessageAt: new Date(Date.now() - 5 * 60_000).toISOString() }];
    render(<DirectoriesPage />);
    expect(row('Ann').textContent).toContain('sweep.weldchat.relativeTime.minutesAgo');
  });

  it('filters on Status: invited, or everyone who joined', () => {
    render(<DirectoriesPage />);
    expect(names()).toEqual(['Ann', 'Bob']);
    fireEvent.click(screen.getByRole('button', { name: 'only invited' }));
    expect(names()).toEqual(['Bob']);
    fireEvent.click(screen.getByRole('button', { name: 'not invited' }));
    expect(names()).toEqual(['Ann']);
  });

  it('offers Send message and Copy email in the row menu, only Copy email for an invitee', async () => {
    const user = userEvent.setup();
    render(<DirectoriesPage />);
    await user.click(within(row('Ann')).getByRole('button', { name: 'common.actions.openMenu: Ann' }));
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual([
      'Send message',
      'sweep.shared.copyEmail',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Send message' }));
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/dm/$userId', params: { userId: 'user_ann' } });
    await user.click(within(row('Bob')).getByRole('button', { name: 'common.actions.openMenu: Bob' }));
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual(['sweep.shared.copyEmail']);
  });
});
