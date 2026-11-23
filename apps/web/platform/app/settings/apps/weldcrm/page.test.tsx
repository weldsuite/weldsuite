import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  tab: null as string | null,
  autoAdd: true,
  push: vi.fn(),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: m.push }),
  useSearchParams: () => new URLSearchParams(m.tab ? `tab=${m.tab}` : ''),
}));
vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => feature === 'crm-auto-add' && m.autoAdd,
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@/lib/i18n', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (namespace: keyof typeof locale) => locale[namespace] };
});
vi.mock('@/app/settings/weldcrm/customer-statuses/page', () => ({ default: () => <p>statuses-tab</p> }));
vi.mock('@/app/settings/apps/task-scheduling-switch', () => ({ TaskSchedulingSwitch: () => <p>tasks-tab</p> }));
vi.mock('@/app/settings/apps/weldcrm/auto-add-settings', () => ({ AutoAddSettings: () => <p>auto-add-tab</p> }));

import WeldCrmSettingsPage from './page';

const autoAddTab = en.crm.settings.autoAdd.tab;

describe('WeldCRM settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.tab = null;
    m.autoAdd = true;
  });

  it('offers the Auto-add tab and opens it from ?tab=auto-add', () => {
    m.tab = 'auto-add';
    render(<WeldCrmSettingsPage />);
    expect(screen.getByRole('tab', { name: autoAddTab })).toBeInTheDocument();
    expect(screen.getByText('auto-add-tab')).toBeInTheDocument();
    expect(screen.queryByText('statuses-tab')).toBeNull();
  });

  it('switches to Auto-add through the tab', async () => {
    render(<WeldCrmSettingsPage />);
    expect(screen.getByText('statuses-tab')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: autoAddTab }));
    expect(m.push).toHaveBeenCalledWith('/settings/apps/weldcrm?tab=auto-add');
  });

  it('has no Auto-add tab where the edition lacks it, and falls back to statuses', () => {
    m.autoAdd = false;
    m.tab = 'auto-add';
    render(<WeldCrmSettingsPage />);
    expect(screen.queryByRole('tab', { name: autoAddTab })).toBeNull();
    expect(screen.getByText('statuses-tab')).toBeInTheDocument();
    expect(screen.queryByText('auto-add-tab')).toBeNull();
  });
});
