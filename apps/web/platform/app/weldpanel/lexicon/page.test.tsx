import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeLexicon } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import LexiconPage from './page';

const state = vi.hoisted(() => ({ canEdit: true, lexicon: undefined as unknown, isError: false, update: vi.fn() }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canEdit }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelLexicon: () => ({ data: state.isError ? undefined : state.lexicon, isLoading: false, isError: state.isError, refetch: vi.fn() }),
  useUpdateWeldPanelLexicon: () => ({ mutateAsync: state.update, isPending: false }),
}));

const tl = en.weldpanel.analytics.lexicon;

describe('Lexicon', () => {
  beforeEach(() => {
    state.canEdit = true;
    state.lexicon = makeLexicon();
    state.isError = false;
    state.update.mockReset();
    state.update.mockResolvedValue(undefined);
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('lists the events seen, verified and busiest first, and leaves hidden ones out', () => {
    render(<LexiconPage />);
    const names = screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(names).toEqual(['Signed up', 'Upgraded']);
    expect(screen.queryByText('Debug ping')).toBeNull();
    expect(screen.getByText('120 events')).toBeTruthy();
  });

  it('shows hidden names on request', async () => {
    render(<LexiconPage />);
    await userEvent.click(screen.getByRole('switch', { name: tl.showHidden }));
    expect(screen.getByText('Debug ping')).toBeTruthy();
  });

  it('switches to the properties', async () => {
    render(<LexiconPage />);
    await userEvent.click(screen.getByRole('tab', { name: tl.properties }));
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.queryByText('internal_id')).toBeNull();
  });

  it('searches names', async () => {
    render(<LexiconPage />);
    await userEvent.type(screen.getByRole('textbox', { name: tl.search }), 'upg');
    expect(screen.queryByText('Signed up')).toBeNull();
    expect(screen.getByText('Upgraded')).toBeTruthy();
    await userEvent.clear(screen.getByRole('textbox', { name: tl.search }));
    await userEvent.type(screen.getByRole('textbox', { name: tl.search }), 'zzz');
    expect(screen.getByText(tl.noMatches)).toBeTruthy();
  });

  it('hides an event from the pickers', async () => {
    render(<LexiconPage />);
    await userEvent.click(screen.getByRole('switch', { name: tl.hiddenLabel.replace('{name}', 'Upgraded') }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ kind: 'event', name: 'Upgraded', hidden: true }));
  });

  it('marks an event as verified', async () => {
    render(<LexiconPage />);
    await userEvent.click(screen.getByRole('switch', { name: tl.verifiedLabel.replace('{name}', 'Upgraded') }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ kind: 'event', name: 'Upgraded', verified: true }));
  });

  it('saves a description when the field loses focus, and only if it changed', async () => {
    render(<LexiconPage />);
    const field = screen.getByRole('textbox', { name: tl.descriptionLabel.replace('{name}', 'Upgraded') });
    await userEvent.click(field);
    await userEvent.tab();
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.type(field, 'Moved to a paid plan');
    await userEvent.tab();
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ kind: 'event', name: 'Upgraded', description: 'Moved to a paid plan' }));
  });

  it('is read-only without the update permission', () => {
    state.canEdit = false;
    render(<LexiconPage />);
    expect(screen.queryByRole('textbox', { name: tl.descriptionLabel.replace('{name}', 'Upgraded') })).toBeNull();
    expect((screen.getByRole('switch', { name: tl.hiddenLabel.replace('{name}', 'Upgraded') }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(tl.needsPermission)).toBeTruthy();
  });

  it('shows an empty state before anything was seen', () => {
    state.lexicon = makeLexicon({ events: [], properties: [] });
    render(<LexiconPage />);
    expect(screen.getByText(tl.emptyTitle)).toBeTruthy();
  });

  it('shows an error state when the lexicon fails to load', () => {
    state.isError = true;
    render(<LexiconPage />);
    expect(screen.getByText(tl.loadFailed)).toBeTruthy();
  });
});
