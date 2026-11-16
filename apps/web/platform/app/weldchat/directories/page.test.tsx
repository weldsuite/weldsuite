import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  members: [] as Array<Record<string, string>>,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({
  useWorkspaceMembers: () => ({ data: { data: state.members }, isLoading: false }),
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
});
