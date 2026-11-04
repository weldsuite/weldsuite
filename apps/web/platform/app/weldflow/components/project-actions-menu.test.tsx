import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const access = vi.hoisted(() => ({ isAdmin: true }));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: router.push }) }));
vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));
vi.mock('@/app/weldflow/contexts/project-permission-context', () => ({
  useProjectPermissions: () => ({ isAdmin: access.isAdmin }),
}));

import { ProjectActionsMenu } from './project-actions-menu';

describe('ProjectActionsMenu', () => {
  beforeEach(() => {
    router.push.mockReset();
    access.isAdmin = true;
  });

  it('opens the close page for someone who manages the project', async () => {
    render(<ProjectActionsMenu projectId="prj_1" />);
    await userEvent.click(screen.getByRole('button', { name: en.projects.projectLayout.projectActions }));
    await userEvent.click(await screen.findByRole('menuitem', { name: en.projects.projectLayout.closeProject }));
    expect(router.push).toHaveBeenCalledWith('/weldflow/project/prj_1/close');
  });

  it('renders nothing for anyone else', () => {
    access.isAdmin = false;
    const { container } = render(<ProjectActionsMenu projectId="prj_1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
