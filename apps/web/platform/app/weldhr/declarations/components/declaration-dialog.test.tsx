import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrDeclarationListItem } from '@weldsuite/app-api-client/domains/weldhr';

const env = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn() }));

vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useCreateHrDeclaration: () => ({ mutateAsync: env.create, isPending: false }),
  useUpdateHrDeclaration: () => ({ mutateAsync: env.update, isPending: false }),
  useUploadHrDeclarationReceipt: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-projects-queries', () => ({
  useProjects: () => ({
    data: { data: [{ id: 'proj_1', name: 'Portal' }, { id: 'proj_2', name: 'Website' }] },
    isLoading: false,
    isError: false,
  }),
  useProject: () => ({ data: undefined }),
}));

import { DeclarationDialog } from './declaration-dialog';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const declaration = (overrides: Partial<HrDeclarationListItem> = {}): HrDeclarationListItem => ({
  id: 'hrdcl_1',
  employeeId: 'hremp_1',
  employeeName: 'Ann Example',
  expenseDate: '2026-03-10',
  category: 'equipment',
  description: 'Load-test licence',
  amount: 280,
  currency: 'EUR',
  projectId: null,
  status: 'pending',
  hasReceipt: false,
  receiptFileName: null,
  receiptContentType: null,
  receiptSize: null,
  submittedBy: 'user_1',
  reviewedBy: null,
  reviewedByName: null,
  reviewedAt: null,
  reviewNote: null,
  paidBy: null,
  paidAt: null,
  createdAt: '2026-03-11T08:00:00.000Z',
  updatedAt: '2026-03-11T08:00:00.000Z',
  ...overrides,
});

describe('DeclarationDialog: the WeldFlow project', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.update.mockReset().mockResolvedValue({});
    env.create.mockReset().mockResolvedValue({ receiptFailed: false });
  });

  it('shows no project by default and sends null when none is picked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeclarationDialog declaration={declaration()} onClose={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('No project');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.update).toHaveBeenCalledTimes(1));
    expect(env.update.mock.calls[0][0]).toMatchObject({ id: 'hrdcl_1', projectId: null });
  });

  it('sends the project picked on the declaration', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeclarationDialog declaration={declaration()} onClose={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Portal' }));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.update).toHaveBeenCalledTimes(1));
    expect(env.update.mock.calls[0][0]).toMatchObject({ projectId: 'proj_1' });
  });

  it('keeps a stored project and takes it off again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeclarationDialog declaration={declaration({ projectId: 'proj_2' })} onClose={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveTextContent('Website');
    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'No project' }));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.update).toHaveBeenCalledTimes(1));
    expect(env.update.mock.calls[0][0]).toMatchObject({ projectId: null });
  });
});
