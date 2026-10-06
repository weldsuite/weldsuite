import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import GeneralSettingsPage from './page';
import { getLogoInitial } from './logo-initial';

// The form owns the page header; stand in for it with just that.
vi.mock('./business-settings-form', () => ({
  BusinessSettingsForm: () => <h1>Business Settings</h1>,
}));

describe('GeneralSettingsPage', () => {
  it('renders the page header once', () => {
    render(<GeneralSettingsPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('getLogoInitial', () => {
  it('uses the first letter of the name, uppercased', () => {
    expect(getLogoInitial('  qa test workspace')).toBe('Q');
  });

  it('falls back to L only when there is no name', () => {
    expect(getLogoInitial('')).toBe('L');
    expect(getLogoInitial('   ')).toBe('L');
    expect(getLogoInitial(undefined)).toBe('L');
  });
});
