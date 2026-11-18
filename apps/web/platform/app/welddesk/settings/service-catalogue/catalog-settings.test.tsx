/**
 * The service catalogue settings page: the ordered list with its summaries,
 * switching an item on or off, moving one, deleting, and the item editor
 * (validation, steps and tasks, what it sends on save).
 */

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { DeskCatalogItem } from '@weldsuite/core-api-client/schemas/desk-catalog';

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  perms: new Set<string>(['welddesk:settings:update']),
  create: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
  update: vi.fn<(input: Record<string, unknown>) => Promise<unknown>>(),
  remove: vi.fn<(id: string) => Promise<unknown>>(),
  refusal: null as { reason: string; count: number } | null,
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@weldsuite/ui/components/lucide-dynamic-icon', () => ({ LucideDynamicIcon: () => null }));
vi.mock('@/app/welddesk/components/company-multi-picker', () => ({
  CompanyMultiPicker: ({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onChange([...value, 'co_new'])}>
      pick company ({value.length})
    </button>
  ),
}));
vi.mock('@/hooks/queries/use-helpdesk-queries', () => ({
  useTicketTypes: () => ({
    data: [
      { id: 'ttyp_hw', name: 'Hardware request', category: 'customer', isActive: true },
      { id: 'ttyp_internal', name: 'Internal task', category: 'internal', isActive: true },
    ],
  }),
}));
vi.mock('@/hooks/queries/use-desk-routing-queries', () => ({
  useDeskTeams: () => ({ data: [{ id: 'dept_it', name: 'IT', isActive: true }] }),
  useDeskTeamMembers: () => ({ data: [{ userId: 'user_a', name: 'Alice' }, { userId: 'user_b', name: 'Bob' }] }),
}));
vi.mock('@/hooks/queries/use-desk-catalog-queries', () => ({
  deskCatalogErrorMessage: () => null,
  deskCatalogRefusal: () => state.refusal?.reason ?? null,
  deskCatalogRefusalCount: () => state.refusal?.count ?? null,
  useDeskCatalogItems: () => ({ data: state.items, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateDeskCatalogItem: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateDeskCatalogItem: () => ({ mutateAsync: state.update, isPending: false }),
  useDeleteDeskCatalogItem: () => ({ mutateAsync: state.remove, isPending: false }),
}));

// Native selects stand in for the Radix ones, which need a real layout. The
// trigger's aria-label names the select.
/** An option holds text only; the editor puts an icon next to some labels. */
function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : '';
    })
    .join('');
}

vi.mock('@weldsuite/ui/components/select', () => {
  const SelectTrigger = (_props: { 'aria-label'?: string; 'aria-invalid'?: boolean; children?: ReactNode }) => null;
  return {
    Select: ({ value, onValueChange, children }: { value?: string; onValueChange: (v: string) => void; children: ReactNode }) => {
      const trigger = Children.toArray(children).find(
        (child): child is ReactElement<{ 'aria-label'?: string }> => isValidElement(child) && child.type === SelectTrigger,
      );
      return (
        <select aria-label={trigger?.props['aria-label']} value={value ?? ''} onChange={(event) => onValueChange(event.target.value)}>
          <option value="">-</option>
          {children}
        </select>
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{plainText(children)}</option>,
  };
});

import { CatalogSettings } from './catalog-settings';

const item = (id: string, extra: Partial<DeskCatalogItem> = {}): DeskCatalogItem => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  name: `Item ${id}`,
  summary: null,
  description: null,
  category: null,
  icon: null,
  ticketTypeId: 'ttyp_hw',
  departmentId: null,
  priority: null,
  deliveryEstimate: null,
  approvalSteps: [],
  fulfilmentTasks: [],
  audienceCompanyIds: [],
  isActive: true,
  sortOrder: 0,
  createdById: null,
  ...extra,
});

beforeEach(() => {
  state.refusal = null;
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  state.perms = new Set(['welddesk:settings:update']);
  state.items = [
    item('a', {
      name: 'Laptop',
      category: 'Hardware',
      sortOrder: 0,
      approvalSteps: [
        { id: 's1', approverType: 'member', approverId: 'user_a' },
        { id: 's2', approverType: 'team_manager', departmentId: 'dept_it' },
      ],
      fulfilmentTasks: [
        { id: 't1', title: 'Order' },
        { id: 't2', title: 'Image' },
      ],
    }),
    item('b', { name: 'VPN access', sortOrder: 1, isActive: false }),
  ];
  state.create.mockReset().mockResolvedValue({});
  state.update.mockReset().mockResolvedValue({});
  state.remove.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('the item list', () => {
  it('summarises each item: form, approvers, tasks, category and whether it is off', () => {
    render(<CatalogSettings />);
    const rows = screen.getAllByTestId('catalog-item-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText('Laptop')).toBeInTheDocument();
    expect(first.getByText('Hardware')).toBeInTheDocument();
    expect(first.getByText(/Form: Hardware request/)).toBeInTheDocument();
    expect(first.getByText(/Approval: Alice, manager of IT/)).toBeInTheDocument();
    expect(first.getByText(/2 fulfilment tasks/)).toBeInTheDocument();
    const second = within(rows[1]!);
    expect(second.getByText('Off')).toBeInTheDocument();
    expect(second.getByText(/No approval/)).toBeInTheDocument();
    expect(second.getByText(/No fulfilment tasks/)).toBeInTheDocument();
  });

  it('switches an item on or off', async () => {
    render(<CatalogSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Show VPN access in the help center' }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: 'b', isActive: true }));
  });

  it('moves an item by renumbering the ones whose position changes', async () => {
    render(<CatalogSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Move VPN access up' }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls.map(([patch]) => patch)).toEqual(
      expect.arrayContaining([
        { id: 'b', sortOrder: 0 },
        { id: 'a', sortOrder: 1 },
      ]),
    );
    expect(screen.getByRole('button', { name: 'Move Laptop up' })).toBeDisabled();
  });

  it('deletes an item after confirming', async () => {
    render(<CatalogSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Laptop' }));
    expect(await screen.findByText(/"Laptop" is removed from the help center/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('a'));
  });

  it('says why an item with requests waiting for approval was not deleted', async () => {
    state.refusal = { reason: 'has_pending_requests', count: 3 };
    state.remove.mockRejectedValueOnce(new Error('conflict'));
    render(<CatalogSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Laptop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('3 requests waiting for approval')));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says it in the singular for one request', async () => {
    state.refusal = { reason: 'has_pending_requests', count: 1 };
    state.remove.mockRejectedValueOnce(new Error('conflict'));
    render(<CatalogSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Laptop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('1 request waiting for approval')));
  });

  it('is read-only without welddesk:settings:update', () => {
    state.perms = new Set();
    render(<CatalogSettings />);
    expect(screen.queryByTestId('catalog-item-new')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Laptop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Laptop' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show Laptop in the help center' })).toBeDisabled();
  });

  it('offers the first item when the catalogue is empty', () => {
    state.items = [];
    render(<CatalogSettings />);
    expect(screen.getByText('No catalogue items yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New item' })).toBeInTheDocument();
  });
});

describe('the item editor', () => {
  const openNew = () => {
    render(<CatalogSettings />);
    fireEvent.click(screen.getByTestId('catalog-item-new'));
    return screen.getByTestId('catalog-item-form');
  };

  it('asks for a name and a form before it saves anything', async () => {
    const form = openNew();
    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    expect(await within(form).findByText('Give the item a name.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Headset' } });
    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    expect(await within(form).findByText('Pick the form for this item.')).toBeInTheDocument();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('offers customer ticket types only, and links to editing the form', () => {
    const form = openNew();
    const select = within(form).getByLabelText('Form (ticket type)');
    expect(within(select).getByText('Hardware request')).toBeInTheDocument();
    expect(within(select).queryByText('Internal task')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'ttyp_hw' } });
    expect(within(form).getByRole('link', { name: 'Edit the form fields' })).toHaveAttribute('href', '/settings/apps/welddesk/ticket-types');
  });

  it('saves a new item with its steps and tasks, appended to the catalogue', async () => {
    const form = openNew();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Headset' } });
    fireEvent.change(within(form).getByLabelText('Category'), { target: { value: 'Hardware' } });
    fireEvent.change(within(form).getByLabelText('Form (ticket type)'), { target: { value: 'ttyp_hw' } });
    fireEvent.change(within(form).getByLabelText('Team'), { target: { value: 'dept_it' } });
    fireEvent.change(within(form).getByLabelText('Priority'), { target: { value: 'high' } });

    fireEvent.click(within(form).getByTestId('catalog-add-step'));
    fireEvent.change(within(form).getByLabelText('Pick a member 1'), { target: { value: 'user_b' } });
    fireEvent.change(within(form).getByLabelText('Step name 1'), { target: { value: 'Budget' } });
    fireEvent.click(within(form).getByTestId('catalog-add-step'));
    fireEvent.change(within(form).getByLabelText('Approver 2'), { target: { value: 'team_manager' } });

    fireEvent.click(within(form).getByTestId('catalog-add-task'));
    fireEvent.change(within(form).getByLabelText('Title 1'), { target: { value: 'Order a headset' } });
    fireEvent.change(within(form).getByLabelText('Due after (days) 1'), { target: { value: '3' } });
    fireEvent.change(within(form).getByLabelText('Assignee 1'), { target: { value: 'user_a' } });
    fireEvent.click(within(form).getByRole('button', { name: 'pick company (0)' }));

    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    const sent = state.create.mock.calls[0]![0] as Record<string, unknown> & {
      approvalSteps: Array<Record<string, unknown>>;
      fulfilmentTasks: Array<Record<string, unknown>>;
    };
    expect(sent).toMatchObject({
      name: 'Headset',
      category: 'Hardware',
      ticketTypeId: 'ttyp_hw',
      departmentId: 'dept_it',
      priority: 'high',
      audienceCompanyIds: ['co_new'],
      isActive: true,
      sortOrder: 2,
    });
    expect(sent.approvalSteps).toEqual([
      expect.objectContaining({ name: 'Budget', approverType: 'member', approverId: 'user_b' }),
      expect.objectContaining({ name: null, approverType: 'team_manager', departmentId: null }),
    ]);
    expect(sent.fulfilmentTasks).toEqual([
      expect.objectContaining({ title: 'Order a headset', assigneeId: 'user_a', dueInDays: 3 }),
    ]);
  });

  it('refuses a member step without a member and removes steps and tasks', async () => {
    const form = openNew();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Headset' } });
    fireEvent.change(within(form).getByLabelText('Form (ticket type)'), { target: { value: 'ttyp_hw' } });
    fireEvent.click(within(form).getByTestId('catalog-add-step'));
    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    expect(await within(form).findByText('Pick an approver for every member step.')).toBeInTheDocument();
    expect(state.create).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole('button', { name: 'Remove step 1' }));
    expect(within(form).queryAllByTestId('catalog-step-row')).toHaveLength(0);
    fireEvent.click(within(form).getByTestId('catalog-add-task'));
    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    expect(await within(form).findByText('Every task needs a title.')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove task 1' }));
    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
  });

  it('edits an existing item and sends the whole item to it', async () => {
    render(<CatalogSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Laptop' }));
    const form = screen.getByTestId('catalog-item-form');
    expect(within(form).getByLabelText('Name')).toHaveValue('Laptop');
    expect(within(form).getAllByTestId('catalog-step-row')).toHaveLength(2);
    expect(within(form).getAllByTestId('catalog-task-row')).toHaveLength(2);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Laptop pro' } });
    fireEvent.click(within(form).getByTestId('catalog-item-save'));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update.mock.calls[0]![0]).toMatchObject({ id: 'a', name: 'Laptop pro', ticketTypeId: 'ttyp_hw' });
    expect(state.create).not.toHaveBeenCalled();
  });
});
