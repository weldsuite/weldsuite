import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DimensionValue } from '@/lib/api/domains/weldbooks';

const mocks = vi.hoisted(() => ({
  list: { data: [] as unknown[], isLoading: false, isError: false, refetch: vi.fn() },
  filters: [] as unknown[],
  createValue: vi.fn(),
  updateValue: vi.fn(),
  deleteValue: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  permissions: { create: true, update: true, delete: true },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => {
    if (permission === 'accounts:create') return mocks.permissions.create;
    if (permission === 'accounts:update') return mocks.permissions.update;
    if (permission === 'accounts:delete') return mocks.permissions.delete;
    return true;
  },
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useDimensionValues: (filters: unknown) => {
    mocks.filters.push(filters);
    return mocks.list;
  },
  useCreateDimensionValue: () => ({ mutateAsync: mocks.createValue, isPending: false }),
  useUpdateDimensionValue: () => ({ mutateAsync: mocks.updateValue, isPending: false }),
  useDeleteDimensionValue: () => ({ mutateAsync: mocks.deleteValue, isPending: false }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import DimensionsPage from './page';

function value(id: string, name: string, extra: Partial<DimensionValue> = {}): DimensionValue {
  return {
    id,
    entityId: 'ent_1',
    dimension: 'class',
    name,
    code: null,
    parentId: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** The server's 409 as the WeldBooks client throws it. */
function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409, code: 'CONFLICT' });
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

describe('DimensionsPage', () => {
  beforeEach(() => {
    mocks.list = {
      data: [
        value('east', 'East', { code: 'E' }),
        value('east-1', 'East 1', { parentId: 'east' }),
        value('old', 'Old', { isActive: false }),
      ],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    mocks.filters = [];
    mocks.createValue.mockReset().mockResolvedValue({ data: value('new', 'New') });
    mocks.updateValue.mockReset().mockResolvedValue({ data: value('x', 'X') });
    mocks.deleteValue.mockReset().mockResolvedValue(undefined);
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.permissions = { create: true, update: true, delete: true };
  });

  it('lists the values as a hierarchy and hides inactive ones until asked', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);

    const table = screen.getByRole('table');
    const names = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['East', 'East 1']);
    expect(within(table).getByText('E')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Show inactive' }));
    expect(within(screen.getByRole('table')).getByText('Old')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Inactive')).toBeInTheDocument();
  });

  it('searches by name or code', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);
    await user.type(screen.getByRole('searchbox', { name: 'Search by name or code' }), 'east 1');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('East 1');
  });

  it('asks for the classes first and the locations on the other tab', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);
    expect(mocks.filters.at(-1)).toMatchObject({ dimension: 'class' });
    await user.click(screen.getByRole('tab', { name: 'Locations' }));
    expect(mocks.filters.at(-1)).toMatchObject({ dimension: 'location' });
  });

  it('adds a class under a parent', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);

    await user.click(screen.getByRole('button', { name: 'Add class' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name *'), 'Retail');
    await user.type(within(dialog).getByLabelText('Code'), 'R1');
    await user.click(within(dialog).getByRole('combobox', { name: 'Parent' }));
    await user.click(await screen.findByRole('option', { name: 'E · East' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.createValue).toHaveBeenCalledTimes(1));
    expect(mocks.createValue).toHaveBeenCalledWith({
      dimension: 'class',
      name: 'Retail',
      code: 'R1',
      parentId: 'east',
      isActive: true,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Added');
  });

  it('requires a name', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);
    await user.click(screen.getByRole('button', { name: 'Add class' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(mocks.createValue).not.toHaveBeenCalled();
  });

  it('does not offer a value or its children as its own parent', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);
    const row = screen.getByRole('row', { name: /^East E/ });
    await user.click(within(row).getByRole('button', { name: 'Edit: East' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Parent' }));
    const options = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['No parent']);
  });

  it('deactivates a value from its menu', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);
    const row = screen.getByRole('row', { name: /East 1/ });
    await user.click(within(row).getByRole('button', { name: 'Edit: East 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));

    await waitFor(() => expect(mocks.updateValue).toHaveBeenCalledWith({ id: 'east-1', data: { isActive: false } }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Deactivated');
  });

  it('deletes a value that is not in use after a confirmation', async () => {
    const user = userEvent.setup();
    render(<DimensionsPage />);
    const row = screen.getByRole('row', { name: /East 1/ });
    await user.click(within(row).getByRole('button', { name: 'Edit: East 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete East 1?')).toBeInTheDocument();
    expect(mocks.deleteValue).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.deleteValue).toHaveBeenCalledWith('east-1'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Deleted');
  });

  it('offers to deactivate a value that is in use when deleting it answers 409', async () => {
    const user = userEvent.setup();
    mocks.deleteValue.mockRejectedValue(conflict("This class is used on bookings — deactivate it instead"));
    render(<DimensionsPage />);
    const row = screen.getByRole('row', { name: /East 1/ });
    await user.click(within(row).getByRole('button', { name: 'Edit: East 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    const inUse = await screen.findByText('East 1 is in use');
    expect(inUse).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Deactivate instead' }));
    await waitFor(() => expect(mocks.updateValue).toHaveBeenCalledWith({ id: 'east-1', data: { isActive: false } }));
  });

  it('reports any other delete failure', async () => {
    const user = userEvent.setup();
    mocks.deleteValue.mockRejectedValue(new Error('Boom'));
    render(<DimensionsPage />);
    const row = screen.getByRole('row', { name: /East 1/ });
    await user.click(within(row).getByRole('button', { name: 'Edit: East 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not delete', { description: 'Boom' }));
    expect(screen.queryByText('East 1 is in use')).not.toBeInTheDocument();
  });

  it('shows an empty state with an add button', () => {
    mocks.list = { ...mocks.list, data: [] };
    render(<DimensionsPage />);
    expect(screen.getByText('No classes yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add class' })).toHaveLength(2);
  });

  it('shows a retryable error', async () => {
    const user = userEvent.setup();
    mocks.list = { ...mocks.list, data: [], isError: true };
    render(<DimensionsPage />);
    expect(screen.getByText('Could not load the classes and locations.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.list.refetch).toHaveBeenCalled();
  });

  it('shows no add button and no menu without permission', () => {
    mocks.permissions = { create: false, update: false, delete: false };
    render(<DimensionsPage />);
    expect(screen.queryByRole('button', { name: 'Add class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit:/ })).not.toBeInTheDocument();
    expect(screen.getByText(/you need permission to update accounts to change them/)).toBeInTheDocument();
  });
});
