import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const access = vi.hoisted(() => ({ isAdmin: true, templates: false }));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: router.push }) }));
vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  useProjectPermissions: () => ({ isAdmin: access.isAdmin }),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (key: string) => key === 'project_templates:manage' && access.templates }),
}));
vi.mock('@/hooks/queries/use-projects-queries', () => ({
  useProject: () => ({ data: { id: 'prj_1', name: 'Customer Portal Relaunch' } }),
}));
vi.mock('@/app/weldflow/templates/_components/save-template-dialog', () => ({
  SaveTemplateDialog: ({ open, projectId, defaultName }: { open: boolean; projectId?: string; defaultName?: string }) =>
    open ? <div role="dialog">{`save ${projectId} as ${defaultName}`}</div> : null,
}));

import { ProjectActionsMenu } from './project-actions-menu';

const openMenu = () =>
  userEvent.click(screen.getByRole('button', { name: en.projects.projectLayout.projectActions }));

describe('ProjectActionsMenu', () => {
  beforeEach(() => {
    router.push.mockReset();
    access.isAdmin = true;
    access.templates = false;
  });

  it('opens the close page for someone who manages the project', async () => {
    render(<ProjectActionsMenu projectId="prj_1" />);
    await openMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: en.projects.projectLayout.closeProject }));
    expect(router.push).toHaveBeenCalledWith('/weldflow/project/prj_1/close');
  });

  it('offers "Save as template" to template managers, with the project name', async () => {
    access.isAdmin = false;
    access.templates = true;
    render(<ProjectActionsMenu projectId="prj_1" />);
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: en.projects.projectLayout.closeProject })).toBeNull();
    await userEvent.click(await screen.findByRole('menuitem', { name: en.flowClosing.close.saveAsTemplate }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('save prj_1 as Customer Portal Relaunch');
  });

  it('renders nothing for someone who may neither close nor save a template', () => {
    access.isAdmin = false;
    const { container } = render(<ProjectActionsMenu projectId="prj_1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
