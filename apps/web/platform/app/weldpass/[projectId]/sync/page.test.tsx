/**
 * The Sync tab only where the edition offers `weldpass-sync`: the hosted EU
 * install pushes no secrets to Cloudflare or Vercel, so its project pages show
 * no Sync tab and the Sync route sends you back to the secrets.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Navigate: ({ to, params }: { to: string; params?: { projectId?: string } }) => (
    <div data-testid="navigate">{to.replace('$projectId', params?.projectId ?? '')}</div>
  ),
}));

vi.mock('@/lib/router', () => ({ useParams: () => ({ projectId: 'wpp_1' }) }));

vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));

const mutation = { mutateAsync: vi.fn() };
vi.mock('@/hooks/queries/use-weldpass-queries', () => ({
  useWeldPassProject: () => ({ data: undefined, isLoading: true }),
  useWeldPassSyncTargets: () => ({ data: [] }),
  useWeldPassCredentials: () => ({ data: [] }),
  useWeldPassSyncRuns: () => ({ data: [], refetch: vi.fn() }),
  usePushWeldPassSyncTarget: () => mutation,
  useUpdateWeldPassSyncTarget: () => mutation,
  useDeleteWeldPassSyncTarget: () => mutation,
  useDeleteWeldPassCredential: () => mutation,
}));

vi.mock('../../components/page-kit', () => ({
  usePassBreadcrumbs: () => undefined,
  TabsPage: ({ tabs, children }: { tabs: { id: string; label: string }[]; children: ReactNode }) => (
    <div>
      <ul aria-label="tabs">
        {tabs.map((tab) => (
          <li key={tab.id}>{tab.label}</li>
        ))}
      </ul>
      {children}
    </div>
  ),
}));

import { setRuntimeConfig } from '@/lib/runtime-config';
import { ProjectPage } from '../components/project-page';
import WeldPassSyncPage from './page';

const EU = { backend: 'rust', edition: 'eu', modules: ['core', 'pass'], unavailableFeatures: ['weldpass-sync'] };

afterEach(() => setRuntimeConfig(null));

function tabLabels() {
  return screen.getAllByRole('listitem').map((item) => item.textContent);
}

describe('WeldPass project tabs', () => {
  it('shows Sync where the edition offers it', () => {
    render(<ProjectPage projectId="wpp_1" section="secrets">body</ProjectPage>);
    expect(tabLabels()).toEqual(['weldpass.secretsTab', 'weldpass.sync', 'weldpass.auditLog']);
  });

  it('leaves Sync out on the EU edition', () => {
    setRuntimeConfig(EU);
    render(<ProjectPage projectId="wpp_1" section="secrets">body</ProjectPage>);
    expect(tabLabels()).toEqual(['weldpass.secretsTab', 'weldpass.auditLog']);
  });
});

describe('WeldPass Sync page', () => {
  it('sends you back to the secrets on the EU edition', () => {
    setRuntimeConfig(EU);
    render(<WeldPassSyncPage />);
    expect(screen.getByTestId('navigate').textContent).toBe('/weldpass/wpp_1');
  });

  it('opens where the edition offers sync', () => {
    render(<WeldPassSyncPage />);
    expect(screen.queryByTestId('navigate')).toBeNull();
  });
});
