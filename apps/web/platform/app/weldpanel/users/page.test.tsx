import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makePerson } from '../observe-fixtures';
import { makeProject } from '../test-fixtures';
import UsersPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_people:read']),
  people: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetchingNextPage: false, hasNextPage: false, fetchNextPage: vi.fn(), refetch: vi.fn() },
  params: [] as Record<string, unknown>[],
  push: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelCohorts: () => ({ data: [{ id: 'coh_1', name: 'Power users' }] }),
  useWeldPanelPeople: (params: Record<string, unknown>) => {
    state.params.push(params);
    return state.people;
  },
}));

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.scrollIntoView ??= () => undefined;

const tu = en.weldpanel.observe.users;
const last = () => state.params[state.params.length - 1]!;
const withPeople = (people = [makePerson(), makePerson({ userId: 'user_7', name: null, email: null, properties: {} })], extra = {}) => ({
  data: { people, totalCount: 1234 },
  error: null,
  isLoading: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  ...extra,
});

describe('Users', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_people:read']);
    state.people = withPeople();
    state.params = [];
    state.push.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists people by name, falling back to the id, with their last seen and property count', () => {
    render(<UsersPage />);
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('user_7')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText('1,234 people')).toBeTruthy();
    expect(screen.getByRole('link', { name: tu.openProfile.replace('{name}', 'Ada Lovelace') }).getAttribute('href')).toBe('/weldpanel/users/user_42?project=wpp_1');
  });

  it('searches after a pause in typing', async () => {
    render(<UsersPage />);
    await userEvent.type(screen.getByLabelText(tu.searchLabel), 'ada');
    await vi.waitFor(() => expect(last()).toMatchObject({ projectId: 'wpp_1', search: 'ada' }));
    expect(state.params.some((p) => p.search === 'a')).toBe(false);
  });

  it('filters by cohort', async () => {
    render(<UsersPage />);
    await userEvent.click(screen.getByRole('combobox', { name: tu.cohort }));
    await userEvent.click(await screen.findByRole('option', { name: 'Power users' }));
    expect(last()).toMatchObject({ cohortId: 'coh_1' });
  });

  it('opens a profile from its row and loads more', async () => {
    state.people = withPeople(undefined, { hasNextPage: true });
    render(<UsersPage />);
    await userEvent.click(screen.getByText('ada@example.com'));
    expect(state.push).toHaveBeenCalledWith('/weldpanel/users/user_42?project=wpp_1');
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.observe.common.loadMore }));
    expect(state.people.fetchNextPage).toHaveBeenCalled();
  });

  it('tells an empty project from an empty search', async () => {
    state.people = withPeople([]);
    const { unmount } = render(<UsersPage />);
    expect(screen.getByText(tu.emptyTitle)).toBeTruthy();
    unmount();
    render(<UsersPage />);
    await userEvent.type(screen.getByLabelText(tu.searchLabel), 'zzz');
    expect(await screen.findByText(tu.emptySearchTitle)).toBeTruthy();
  });

  it('needs the people permission', () => {
    state.perms = new Set();
    render(<UsersPage />);
    expect(screen.getByText(en.weldpanel.observe.common.noPermission)).toBeTruthy();
    expect(state.params).toHaveLength(0);
  });
});
