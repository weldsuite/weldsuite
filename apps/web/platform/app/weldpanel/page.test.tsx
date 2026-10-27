import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import WeldPanelHome from './page';

const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'nl', canCreate: true }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale }) };
});

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));

describe('WeldPanel home (phase 0)', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.canCreate = true;
  });

  it('shows the empty state and the three steps', () => {
    render(<WeldPanelHome />);
    const th = en.weldpanel.home;
    expect(screen.getByRole('heading', { name: th.title })).toBeTruthy();
    expect(screen.getByText(th.emptyTitle)).toBeTruthy();
    for (const step of Object.values(th.steps)) expect(screen.getByText(step.title)).toBeTruthy();
  });

  it('shows a disabled new-project button until projects exist', () => {
    render(<WeldPanelHome />);
    const button = screen.getByRole('button', { name: en.weldpanel.home.newProject }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(en.weldpanel.home.comingSoon)).toBeTruthy();
  });

  it('hides the button without panel_projects:create', () => {
    state.canCreate = false;
    render(<WeldPanelHome />);
    expect(screen.queryByRole('button', { name: en.weldpanel.home.newProject })).toBeNull();
  });

  it('renders in Dutch', () => {
    state.locale = 'nl';
    render(<WeldPanelHome />);
    expect(screen.getByRole('heading', { name: nl.weldpanel.home.title })).toBeTruthy();
    expect(screen.getByText(nl.weldpanel.home.emptyTitle)).toBeTruthy();
  });
});
