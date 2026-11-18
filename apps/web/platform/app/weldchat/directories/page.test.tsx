import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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
  }),
}));
// The list shell is not what this page decides; render its rows directly.
vi.mock('@/components/entity-list', () => ({
  EntityList: ({ items, renderRow }: { items: unknown[]; renderRow: (item: unknown) => ReactNode }) => (
    <div>{items.map(renderRow)}</div>
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

describe('WeldChat directory', () => {
  it('opens the DM with someone who joined', () => {
    render(<DirectoriesPage />);
    const row = screen.getByText('Ann').closest('button');
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(state.navigate).toHaveBeenCalledWith({ to: '/weldchat/dm/$userId', params: { userId: 'user_ann' } });
  });

  it("shows an invitee as Invited, on a row that doesn't open anything", () => {
    render(<DirectoriesPage />);
    const name = screen.getByText('Bob');
    expect(name.closest('button')).toBeNull();
    const row = name.closest('[title]');
    expect(row?.getAttribute('title')).toBe('Can be messaged once they accept the invitation');
    expect(row?.textContent).toContain('Invited');
    fireEvent.click(name);
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('tells two people with the same name apart by their address', () => {
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
    const row = screen.getByText('Ann').closest('button');
    expect(row?.textContent).toContain('sweep.weldchat.relativeTime.minutesAgo');
  });
});
