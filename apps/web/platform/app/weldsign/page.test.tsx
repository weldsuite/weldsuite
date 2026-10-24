import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import WeldSignHome from './page';

const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'nl', canCreate: true }));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: state.locale === 'nl' ? dutch : english, language: state.locale }) };
});

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canCreate }));

describe('WeldSign home (phase 0)', () => {
  beforeEach(() => {
    state.locale = 'en';
    state.canCreate = true;
  });

  it('shows the empty state and the three steps', () => {
    render(<WeldSignHome />);
    const th = en.weldsign.home;
    expect(screen.getByRole('heading', { name: th.title })).toBeTruthy();
    expect(screen.getByText(th.emptyTitle)).toBeTruthy();
    for (const step of Object.values(th.steps)) expect(screen.getByText(step.title)).toBeTruthy();
  });

  it('shows a disabled new-request button until sending exists', () => {
    render(<WeldSignHome />);
    const button = screen.getByRole('button', { name: en.weldsign.home.newRequest }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(en.weldsign.home.comingSoon)).toBeTruthy();
  });

  it('hides the button without sign_envelopes:create', () => {
    state.canCreate = false;
    render(<WeldSignHome />);
    expect(screen.queryByRole('button', { name: en.weldsign.home.newRequest })).toBeNull();
  });

  it('renders in Dutch', () => {
    state.locale = 'nl';
    render(<WeldSignHome />);
    expect(screen.getByRole('heading', { name: nl.weldsign.home.title })).toBeTruthy();
    expect(screen.getByText(nl.weldsign.home.emptyTitle)).toBeTruthy();
  });
});
