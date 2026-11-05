import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { ProjectTabSettings } from '@weldsuite/app-api-client/schemas/project-tabs';

const state = vi.hoisted(() => ({
  settings: { hidden: [], roles: { member: [], viewer: [] }, members: [] } as ProjectTabSettings,
  mutate: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));
vi.mock('@/lib/edition', () => ({ isModuleOffered: () => true }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/queries/use-projects-queries', () => ({
  useProject: () => ({ data: { data: { id: 'prj_1', name: 'Portal', projectManagerId: 'user_pm' } } }),
}));
vi.mock('@/hooks/queries/use-project-tab-settings', () => ({
  useProjectTabSettings: () => ({ settings: state.settings, isLoading: false }),
  useUpdateProjectTabSettings: () => ({ mutate: state.mutate }),
}));
// The section reads the permission context only through `useProjectTabDefs`' module.
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({ useProjectPermissions: () => ({}) }));
vi.mock('@/lib/auth', () => ({ useUser: () => ({ user: null }) }));

import { TabsSection, type TabsSectionMember } from './tabs-section';

const copy = en.projects.settings;
const tabs = en.projects.projectLayout.tabs;

const MEMBERS: TabsSectionMember[] = [
  { userId: 'user_pm', role: 'member', isActive: true, user: { name: 'Pat Manager', email: 'pm@example.test' } },
  { userId: 'user_admin', role: 'admin', isActive: true, user: { name: 'Ada Admin', email: 'ada@example.test' } },
  { userId: 'user_mem', role: 'member', isActive: true, user: { name: 'Mo Member', email: 'mo@example.test' } },
  { userId: 'user_view', role: 'Viewer', isActive: true, user: { name: 'Vi Viewer', email: 'vi@example.test' } },
  { userId: 'user_gone', role: 'member', isActive: false, user: { name: 'Gone Member', email: 'gone@example.test' } },
];

const sent = () => state.mutate.mock.calls.at(-1)?.[0] as ProjectTabSettings;

describe('TabsSection', () => {
  beforeEach(() => {
    state.settings = { hidden: [], roles: { member: [], viewer: [] }, members: [] };
    state.mutate.mockReset();
  });

  it('turns a tab off for the whole project', async () => {
    render(<TabsSection projectId="prj_1" isAdmin members={MEMBERS} />);
    await userEvent.click(screen.getByRole('switch', { name: tabs.finance }));
    expect(sent()).toEqual({ hidden: ['finance'], roles: { member: [], viewer: [] }, members: [] });
  });

  it('hides a tab for viewers by default, and leaves a tab off for the project out of the role table', async () => {
    state.settings = { hidden: ['raid'], roles: { member: [], viewer: [] }, members: [] };
    render(<TabsSection projectId="prj_1" isAdmin members={MEMBERS} />);
    expect(screen.queryByRole('checkbox', { name: `${tabs.raid}: ${copy.tabsColumnViewers}` })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: `${tabs.timesheet}: ${copy.tabsColumnViewers}` }));
    expect(sent().roles).toEqual({ member: [], viewer: ['timesheet'] });
    expect(sent().hidden).toEqual(['raid']);
  });

  it('lists only active members and viewers, not admins or the project manager', () => {
    render(<TabsSection projectId="prj_1" isAdmin members={MEMBERS} />);
    expect(screen.getByText('Mo Member')).toBeInTheDocument();
    expect(screen.getByText('Vi Viewer')).toBeInTheDocument();
    expect(screen.queryByText('Ada Admin')).toBeNull();
    expect(screen.queryByText('Pat Manager')).toBeNull();
    expect(screen.queryByText('Gone Member')).toBeNull();
  });

  it("gives one member their own tabs, starting from their role's default", async () => {
    state.settings = { hidden: [], roles: { member: ['finance'], viewer: [] }, members: [] };
    render(<TabsSection projectId="prj_1" isAdmin members={MEMBERS} />);
    const row = screen.getByText('Mo Member').closest('div.flex.items-center.justify-between') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: copy.tabsChoose }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: tabs.finance })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: tabs.gantt }));
    await userEvent.click(within(dialog).getByRole('button', { name: en.common.actions.save }));

    expect(sent().members).toEqual([{ userId: 'user_mem', hidden: ['finance', 'gantt'] }]);
  });

  it('hands a member back to the default of their role', async () => {
    state.settings = { hidden: [], roles: { member: [], viewer: [] }, members: [{ userId: 'user_view', hidden: ['files'] }] };
    render(<TabsSection projectId="prj_1" isAdmin members={MEMBERS} />);
    expect(
      screen.getByText(copy.tabsOwnSelection.replace('{count}', '15').replace('{total}', '16')),
    ).toBeInTheDocument();
    const row = screen.getByText('Vi Viewer').closest('div.flex.items-center.justify-between') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: copy.tabsChoose }));
    await userEvent.click(await screen.findByRole('button', { name: copy.tabsUseRoleDefault }));
    expect(sent().members).toEqual([]);
  });

  it('is read-only for someone who does not manage the project', () => {
    render(<TabsSection projectId="prj_1" isAdmin={false} members={MEMBERS} />);
    expect(screen.getByText(copy.tabsAdminOnly)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: tabs.finance })).toBeDisabled();
    expect(screen.queryByText(copy.tabsMembersTitle)).toBeNull();
  });
});
