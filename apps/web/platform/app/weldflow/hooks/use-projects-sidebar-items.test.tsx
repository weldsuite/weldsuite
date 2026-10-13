import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../lib/api-client', () => ({
  projectsApi: { list: api.list, create: api.create },
  stagesApi: {},
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

vi.mock('@/lib/events/data-events', () => ({ useDataEvent: () => {} }));
vi.mock('@weldsuite/realtime/react', () => ({ useTopic: () => {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useProjectsSidebarItems } from './use-projects-sidebar-items';

function Harness() {
  const { menuGroups, dialogs } = useProjectsSidebarItems(true);
  const projectsGroup = menuGroups.find((g) => g.onAdd);
  return (
    <>
      <button type="button" onClick={() => projectsGroup?.onAdd?.()}>
        open-add-project
      </button>
      {dialogs}
    </>
  );
}

describe('useProjectsSidebarItems: create project dialog', () => {
  beforeEach(() => {
    api.list.mockReset().mockResolvedValue({ success: true, data: [] });
    api.create.mockReset();
  });

  it('creates one project when Create is clicked repeatedly while the request is pending', async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    api.create.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );

    render(<Harness />);
    await act(async () => {});

    fireEvent.click(screen.getByText('open-add-project'));
    const input = screen.getByPlaceholderText(en.projects.sidebar.namePlaceholder);
    fireEvent.change(input, { target: { value: 'Launch' } });

    const createButton = screen.getByRole('button', { name: en.projects.sidebar.createProject });
    fireEvent.click(createButton);
    fireEvent.click(createButton);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(createButton).toBeDisabled();

    await act(async () => {
      resolveCreate({ success: true, data: { id: 'proj_1', name: 'Launch' } });
    });

    expect(api.create).toHaveBeenCalledTimes(1);
  });
});
