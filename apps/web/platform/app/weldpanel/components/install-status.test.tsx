import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { PanelInstallInfo } from '@weldsuite/app-api-client/schemas/weldpanel';
import { makeInstall } from '../test-fixtures';
import { InstallStatus } from './install-status';

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  install: undefined as unknown,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  asked: [] as string[],
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale, format: interpolate }) };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelInstall: (projectId: string) => {
    state.asked.push(projectId);
    return { data: state.install, isLoading: state.isLoading, isError: state.isError, refetch: state.refetch };
  },
}));

const ti = en.weldpanel.install;

function show(install: PanelInstallInfo | undefined, props: { paused?: boolean; showLink?: boolean } = {}) {
  state.install = install;
  return render(<InstallStatus projectId="wpp_1" paused={props.paused ?? false} showLink={props.showLink} />);
}

describe('InstallStatus', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.install = undefined;
    state.isLoading = false;
    state.isError = false;
    state.refetch.mockReset();
    state.asked = [];
  });

  it('waits for the first event and says it keeps checking', () => {
    show(makeInstall({ status: 'waiting', lastEventAt: null }));
    expect(screen.getByText(ti.waiting)).toBeTruthy();
    expect(screen.getByText(ti.noEvents)).toBeTruthy();
    expect(screen.getByText(ti.pollHint)).toBeTruthy();
    for (const step of Object.values(ti.steps)) expect(screen.getByText(step)).toBeTruthy();
    expect(state.asked).toContain('wpp_1');
  });

  it('shows the time of the last event once events arrive', () => {
    show(makeInstall({ status: 'receiving', lastEventAt: '2026-10-27T08:30:00.000Z' }));
    expect(screen.getByText(ti.receiving)).toBeTruthy();
    expect(screen.queryByText(ti.pollHint)).toBeNull();
    const detail = screen.getByText(/^Last event /);
    expect(detail.textContent).toMatch(/2026/);
  });

  it('says events are arriving when the collector has no time for them', () => {
    show(makeInstall({ status: 'receiving', lastEventAt: null }));
    expect(screen.getByText(ti.arriving)).toBeTruthy();
  });

  it('says collection is paused instead of "receiving"', () => {
    show(makeInstall({ status: 'receiving', lastEventAt: '2026-10-27T08:30:00.000Z' }), { paused: true });
    expect(screen.getByText(ti.paused)).toBeTruthy();
    expect(screen.getByText(ti.pausedNote)).toBeTruthy();
    expect(screen.queryByText(ti.receiving)).toBeNull();
  });

  it('offers a retry when the check fails', async () => {
    state.isError = true;
    show(undefined);
    expect(screen.getByText(ti.loadFailed)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.retry }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('links to the install instructions only when asked to', () => {
    const { unmount } = show(makeInstall(), { showLink: true });
    expect(screen.getByRole('link', { name: ti.openProject }).getAttribute('href')).toBe('/weldpanel/projects/wpp_1');
    unmount();
    show(makeInstall());
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders in Dutch', () => {
    state.locale = 'nl';
    show(makeInstall({ status: 'waiting' }));
    expect(screen.getByText(nl.weldpanel.install.waiting)).toBeTruthy();
    expect(screen.getByText(nl.weldpanel.install.steps.open)).toBeTruthy();
  });
});
