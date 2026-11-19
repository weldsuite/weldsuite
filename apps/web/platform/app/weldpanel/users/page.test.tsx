import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makePerson } from '../observe-fixtures';
import { makeProject } from '../test-fixtures';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
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
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/components/object-panel', async () => ({
  ...(await import('@/components/objects/_shared/object-panel-test-mock')),
  // The standard list reports the rows it shows, for the panel's previous / next.
  useObjectPanelNavigationReporter: () => () => undefined,
}));
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
/** The list's search box (it renders one for mobile and one for desktop; either searches). */
const searchBox = () => screen.getAllByRole('textbox', { name: tu.searchPlaceholder })[0]!;

/**
 * Adds a finished `is` filter pill through the toolbar: "Filter" > field > "is" > value.
 * The pill opens its value picker on a timer; when the options are not there yet, open it by hand.
 */
async function addIsFilter(user: ReturnType<typeof userEvent.setup>, field: string, value: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Filter' }));
  await user.click(await screen.findByRole('button', { name: field }));
  await user.click(await screen.findByRole('button', { name: 'is' }));
  const option = await screen.findByRole('button', { name: value }, { timeout: 400 }).catch(async () => {
    await user.click(screen.getByRole('button', { name: `Select ${field.toLowerCase()}` }));
    return screen.findByRole('button', { name: value });
  });
  await user.click(option);
}
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
    panelOpen.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists people as standard rows: name (falling back to the id) with an avatar, email, last seen and property count', () => {
    render(<UsersPage />);
    expect(screen.getByText(tu.columns.person)).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('AL')).toBeTruthy();
    expect(screen.getByText('user_7')).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    // No title block or count above the list: the breadcrumb names the page.
    expect(screen.queryByRole('heading', { name: tu.title })).toBeNull();
    expect(screen.queryByText('1,234 people')).toBeNull();
  });

  it('searches after a pause in typing', async () => {
    render(<UsersPage />);
    await userEvent.type(searchBox(), 'ada');
    await vi.waitFor(() => expect(last()).toMatchObject({ projectId: 'wpp_1', search: 'ada' }));
    expect(state.params.some((p) => p.search === 'a')).toBe(false);
  });

  it('filters by cohort from the toolbar', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await addIsFilter(user, tu.cohort, 'Power users');
    await vi.waitFor(() => expect(last()).toMatchObject({ cohortId: 'coh_1' }));
  });

  it('opens a person in the record panel from its row, and loads more at the bottom', async () => {
    // The list's bottom sentinel is in view straight away.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe() {
          this.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
        disconnect() {}
        unobserve() {}
      },
    );
    state.people = withPeople(undefined, { hasNextPage: true });
    render(<UsersPage />);
    // The whole row is one click target, opening the person's record panel.
    await userEvent.click(screen.getAllByRole('button', { name: en.common.actions.view })[0]!);
    expect(panelOpen).toHaveBeenCalledWith({ type: 'panel_person', id: 'wpp_1~user_42' });
    // Scrolling to the bottom loads the next page.
    await vi.waitFor(() => expect(state.people.fetchNextPage).toHaveBeenCalled());
  });

  it('tells an empty project from an empty search', async () => {
    state.people = withPeople([]);
    const { unmount } = render(<UsersPage />);
    expect(screen.getByText(tu.emptyTitle)).toBeTruthy();
    unmount();
    render(<UsersPage />);
    await userEvent.type(searchBox(), 'zzz');
    expect(await screen.findByText(tu.emptySearchTitle)).toBeTruthy();
  });

  it('needs the people permission', () => {
    state.perms = new Set();
    render(<UsersPage />);
    expect(screen.getByText(en.weldpanel.observe.common.noPermission)).toBeTruthy();
    expect(state.params).toHaveLength(0);
  });
});
