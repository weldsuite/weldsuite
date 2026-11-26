import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';

const state = vi.hoisted(() => ({ agile: true }));

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => state.agile }));
vi.mock('./general-section', () => ({ GeneralSection: () => <div>general-section</div> }));
vi.mock('./labels-section', () => ({ LabelsSection: () => <div>labels-section</div> }));
vi.mock('./stages-section', () => ({ StagesSection: () => <div>stages-section</div> }));
vi.mock('./github-section', () => ({ GithubSection: () => <div>github-section</div> }));
vi.mock('./import-section', () => ({ ImportSection: () => <div>import-section</div> }));
vi.mock('./tabs-section', () => ({ TabsSection: () => <div>tabs-section</div> }));
vi.mock('../members/members-client', () => ({ MembersClient: () => <div>members-client</div> }));
vi.mock('./delivery-section', () => ({
  DeliverySection: ({ isAdmin }: { isAdmin: boolean }) => <div>delivery-section {String(isAdmin)}</div>,
}));
vi.mock('./item-types-section', () => ({ ItemTypesSection: () => <div>item-types-section</div> }));

import { SettingsClient } from './settings-client';

function renderClient() {
  return render(
    <I18nProvider initialLanguage="en">
      <SettingsClient projectId="p1" members={[]} availableUsers={[]} isAdmin canWrite isViewer={false} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.agile = true;
  window.history.replaceState(null, '', '/');
});

describe('SettingsClient agile sub-tabs', () => {
  it('lists Delivery approach and Item types where agile delivery is available', () => {
    renderClient();
    expect(screen.getByRole('button', { name: 'Delivery approach' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Item types' })).toBeInTheDocument();
    expect(screen.getByText('general-section')).toBeInTheDocument();
  });

  it('leaves them out where it is not', () => {
    state.agile = false;
    renderClient();
    expect(screen.queryByRole('button', { name: 'Delivery approach' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Item types' })).toBeNull();
  });

  it('opens the delivery section and puts it in the address', async () => {
    renderClient();
    await userEvent.click(screen.getByRole('button', { name: 'Delivery approach' }));
    expect(screen.getByText('delivery-section true')).toBeInTheDocument();
    expect(window.location.hash).toBe('#delivery');
    expect(screen.getByRole('heading', { name: 'Delivery approach' })).toBeInTheDocument();
  });

  it('opens the item types section', async () => {
    renderClient();
    await userEvent.click(screen.getByRole('button', { name: 'Item types' }));
    expect(screen.getByText('item-types-section')).toBeInTheDocument();
    expect(window.location.hash).toBe('#item-types');
  });

  it('opens on the section named in the address', () => {
    window.history.replaceState(null, '', '/#item-types');
    renderClient();
    expect(screen.getByText('item-types-section')).toBeInTheDocument();
  });

  it('ignores an agile section in the address where agile is not available', () => {
    state.agile = false;
    window.history.replaceState(null, '', '/#delivery');
    renderClient();
    expect(screen.getByText('general-section')).toBeInTheDocument();
  });

  it('follows a change of the address hash', async () => {
    renderClient();
    window.location.hash = '#delivery';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByText('delivery-section true')).toBeInTheDocument();
  });

  it('shows the other sections too', async () => {
    renderClient();
    for (const [name, text] of [
      [en.projects.settings.membersLabel, 'members-client'],
      [en.projects.settings.tabsLabel, 'tabs-section'],
      [en.projects.settings.labelsLabel, 'labels-section'],
      [en.projects.settings.stagesLabel, 'stages-section'],
      [en.projects.settings.githubLabel, 'github-section'],
      [en.projects.settings.importLabel, 'import-section'],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name }));
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});
