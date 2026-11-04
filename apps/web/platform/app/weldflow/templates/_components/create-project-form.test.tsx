import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    language: 'en',
    t: en,
    plural: (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en'),
    format: interpolate,
  }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ userId: 'u_sanne' }) }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: router.push }) }));
const api = vi.hoisted(() => ({ create: { mutateAsync: vi.fn(), isPending: false } }));
vi.mock('@/hooks/queries/use-project-closing-queries', () => ({ useCreateProjectFromTemplate: () => api.create }));
vi.mock('@/app/weldflow/project/[projectId]/close/_lib/members', () => ({
  useMemberDirectory: () => ({
    members: [
      { userId: 'u_noor', name: 'Noor Hendriks', email: null, avatar: null },
      { userId: 'u_sanne', name: 'Sanne Jansen', email: null, avatar: null },
    ],
    memberOf: () => null,
    isLoading: false,
  }),
}));
vi.mock('./company-picker', () => ({
  CompanyPicker: ({ onChange }: { onChange: (company: { id: string; name: string } | null) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'cmp_1', name: 'Van Dalen' })}>
      Pick company
    </button>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateProjectForm } from './create-project-form';
import { makeTemplate } from '../_lib/test-fixtures';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  router.push.mockReset();
  api.create.mutateAsync.mockReset().mockResolvedValue({ data: { project: { id: 'prj_new', name: 'Supplier portal' } } });
});

describe('CreateProjectForm', () => {
  it('shows the end date the server will compute and moves it with the start', () => {
    render(<CreateProjectForm template={makeTemplate()} canCreate />);
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2027-01-11' } });
    expect(screen.getByRole('status', { name: 'End' })).toHaveTextContent('May 31, 2027');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2027-02-01' } });
    expect(screen.getByRole('status', { name: 'End' })).toHaveTextContent('Jun 21, 2027');
  });

  it('asks for a project name before it sends anything', async () => {
    render(<CreateProjectForm template={makeTemplate()} canCreate />);
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('This field is required')).toBeInTheDocument();
    expect(api.create.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows an invalid start date as a field error', async () => {
    render(<CreateProjectForm template={makeTemplate()} canCreate />);
    await userEvent.type(screen.getByLabelText('Project name'), 'Supplier portal');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Enter a valid date')).toBeInTheDocument();
  });

  it('creates the project with the roles, client and copy options, then opens it', async () => {
    render(<CreateProjectForm template={makeTemplate()} canCreate />);
    await userEvent.type(screen.getByLabelText('Project name'), 'Supplier portal');
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2027-01-11' } });
    await userEvent.click(screen.getByRole('button', { name: 'Pick company' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Sponsor' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Noor Hendriks' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Starting risks and assumptions/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(api.create.mutateAsync).toHaveBeenCalledTimes(1));
    expect(api.create.mutateAsync).toHaveBeenCalledWith({
      id: 'tpl_1',
      data: {
        name: 'Supplier portal',
        startDate: '2027-01-11',
        clientId: 'cmp_1',
        roles: { project_manager: 'u_sanne', sponsor: 'u_noor' },
        copy: { phases: true, milestones: true, deliverables: true, tasks: true, stages: true, raid: false, changeControl: true, statusReport: true },
      },
    });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/weldflow/project/prj_new'));
  });

  it('shows the API message when the project could not be created', async () => {
    const { ApiError } = await import('@weldsuite/api-client');
    api.create.mutateAsync.mockRejectedValue(new ApiError("The template has no role 'x'", 400));
    render(<CreateProjectForm template={makeTemplate()} canCreate />);
    await userEvent.type(screen.getByLabelText('Project name'), 'Supplier portal');
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("The template has no role 'x'");
    expect(router.push).not.toHaveBeenCalled();
  });

  it('does not offer the form without permission to create projects', () => {
    render(<CreateProjectForm template={makeTemplate()} canCreate={false} />);
    expect(screen.getByText(en.flowClosing.templates.form.noAccess)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
  });

  it('asks to select a template first', () => {
    render(<CreateProjectForm template={null} canCreate />);
    expect(screen.getByText(en.flowClosing.templates.form.selectFirst)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
  });
});
