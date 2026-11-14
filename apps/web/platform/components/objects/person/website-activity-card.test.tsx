import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { makeActivity, makePerson, makeSession } from '@/app/weldpanel/observe-fixtures';
import { WebsiteActivityCard } from './website-activity-card';

const state = vi.hoisted(() => ({
  installed: true,
  loading: false,
  analytics: true,
  perms: new Set<string>(['panel_people:read', 'panel_recordings:read']),
  result: { data: undefined as unknown },
  emails: [] as (string | null | undefined)[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: state.installed, isLoading: state.loading }) }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => state.analytics }));
vi.mock('@/lib/router', () => ({ Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelPeopleByEmail: (email: string | null | undefined) => {
    state.emails.push(email);
    return state.result;
  },
}));

const tw = en.crm.websiteActivity;
const entry = (overrides = {}) => ({
  projectId: 'wpp_1',
  projectName: 'Marketing site',
  person: makePerson(),
  recentEvents: [makeActivity(), makeActivity({ eventId: 'e2', name: 'Signed up', path: null }), makeActivity({ eventId: 'e3', name: '$rageclick', path: '/x' })],
  sessions: [makeSession(), makeSession({ sessionId: 'ses_no', hasRecording: false })],
  ...overrides,
});

describe('WebsiteActivityCard', () => {
  beforeEach(() => {
    state.installed = true;
    state.loading = false;
    state.analytics = true;
    state.perms = new Set(['panel_people:read', 'panel_recordings:read']);
    state.result = { data: { people: [entry()] } };
    state.emails = [];
  });

  it('shows when the person was last on the site, what they did and their recordings', () => {
    render(<WebsiteActivityCard email="ada@example.com" />);
    expect(screen.getByRole('region', { name: tw.title })).toBeTruthy();
    expect(screen.getByText(/Last on the site/)).toBeTruthy();
    expect(screen.getByText('Viewed /pricing')).toBeTruthy();
    expect(screen.getByText('Signed up')).toBeTruthy();
    expect(screen.getByText('rageclick')).toBeTruthy();
    // Only the session that has a recording is listed.
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/weldpanel/users/user_42?project=wpp_1', '/weldpanel/recordings/ses_1?project=wpp_1']);
  });

  it('looks the person up by email', () => {
    render(<WebsiteActivityCard email="ada@example.com" />);
    expect(state.emails.at(-1)).toBe('ada@example.com');
  });

  it('names the project when there is more than one', () => {
    state.result = { data: { people: [entry(), entry({ projectId: 'wpp_2', projectName: 'Docs site' })] } };
    render(<WebsiteActivityCard email="ada@example.com" />);
    expect(screen.getByText('Docs site')).toBeTruthy();
    expect(screen.getByText('Marketing site')).toBeTruthy();
  });

  it('renders nothing when the person has never visited', () => {
    state.result = { data: { people: [] } };
    const { container } = render(<WebsiteActivityCard email="ada@example.com" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing while loading, on an error, or without an email', () => {
    state.result = { data: undefined };
    const { container } = render(<WebsiteActivityCard email={null} />);
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['WeldPanel is not installed', () => (state.installed = false)],
    ['the apps are still loading', () => (state.loading = true)],
    ['the edition has no analytics', () => (state.analytics = false)],
    ['the viewer may not read profiles', () => (state.perms = new Set(['panel_recordings:read']))],
  ])('stays away, and does not ask the API, when %s', (_name, change) => {
    change();
    const { container } = render(<WebsiteActivityCard email="ada@example.com" />);
    expect(container.innerHTML).toBe('');
    expect(state.emails.every((email) => email === null)).toBe(true);
  });

  it('leaves out the recordings for people who may not watch them', () => {
    state.perms = new Set(['panel_people:read']);
    render(<WebsiteActivityCard email="ada@example.com" />);
    expect(screen.queryByText(tw.recordings)).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
