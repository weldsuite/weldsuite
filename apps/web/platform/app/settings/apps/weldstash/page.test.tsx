import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setRuntimeConfig } from '@/lib/runtime-config';

vi.mock('@/components/edition-unavailable-page', () => ({
  EditionUnavailablePage: () => <div>Not available in this edition</div>,
}));
vi.mock('./settings-tab', () => ({ SettingsTab: () => <div>settings tab</div> }));
vi.mock('./carriers-section', () => ({ CarriersSection: () => <div>carriers section</div> }));

import WeldStashSettingsPage from './page';

afterEach(() => setRuntimeConfig(null));

describe('WeldStashSettingsPage', () => {
  it('is the edition-unavailable page on Global', () => {
    render(<WeldStashSettingsPage />);
    expect(screen.getByText('Not available in this edition')).toBeInTheDocument();
    expect(screen.queryByText('settings tab')).not.toBeInTheDocument();
  });

  it('shows the title and the settings on the Rust editions', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] } as never);
    render(<WeldStashSettingsPage />);
    expect(screen.getByRole('heading', { name: 'WeldStash' })).toBeInTheDocument();
    expect(screen.getByText('Settings for replenishment and the sales history it learns from.')).toBeInTheDocument();
    expect(screen.getByText('settings tab')).toBeInTheDocument();
    expect(screen.getByText('carriers section')).toBeInTheDocument();
  });
});
