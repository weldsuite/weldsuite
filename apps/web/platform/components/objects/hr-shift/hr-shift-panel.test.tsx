import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';

const deleteAsync = vi.fn();
const toastError = vi.fn();
const permissions = new Set<string>();
/** What the schedule has loaded: the shift, nothing yet (undefined) or no such shift (null). */
let loadedShift: HrShift | null | undefined;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (message: string) => toastError(message) } }));
vi.mock('@/app/weldcalendar/lib/calendar-format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/weldcalendar/lib/calendar-format')>()),
  useTimeFormat: () => '24h',
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useLoadedHrShift: () => loadedShift,
  useDeleteHrShift: () => ({ mutateAsync: deleteAsync, isPending: false }),
}));
vi.mock('@/app/weldhr/attendance/components/shift-dialog', () => ({
  ShiftDialog: ({ onClose, onDelete }: { onClose: () => void; onDelete?: () => void }) => (
    <div role="dialog" aria-label="Shift editor">
      <button type="button" onClick={onClose}>
        Close the editor
      </button>
      {onDelete && (
        <button type="button" onClick={onDelete}>
          Delete from the editor
        </button>
      )}
    </div>
  ),
}));

import { HrShiftPanel } from './hr-shift-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeShift(extra: Partial<HrShift> = {}): HrShift {
  return {
    id: 'shift_1',
    employeeId: 'hremp_ann',
    employeeName: 'Ann Archer',
    companyId: null,
    companyName: null,
    startsAt: new Date(2026, 10, 18, 9, 0).toISOString(),
    endsAt: new Date(2026, 10, 18, 17, 30).toISOString(),
    workType: null,
    breakStartsAt: null,
    breakEndsAt: null,
    notes: null,
    ...extra,
  };
}

function renderPanel(onClose = vi.fn()) {
  return renderWithProviders(<HrShiftPanel id="shift_1" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />);
}

describe('HrShiftPanel', () => {
  beforeEach(() => {
    deleteAsync.mockReset().mockResolvedValue({});
    toastError.mockReset();
    panelOpen.mockReset();
    permissions.clear();
    loadedShift = makeShift();
  });

  it('shows the shift with its optional fields empty', () => {
    renderPanel();

    expect(screen.getByText('Ann Archer')).toBeInTheDocument();
    expect(screen.getByText(/09:00/)).toBeInTheDocument();
    // Break, work type, client and notes have no value.
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('shows the work type, the break, the client and the notes when they are set', () => {
    loadedShift = makeShift({
      workType: 'Cashier',
      companyName: 'Acme',
      notes: 'Bring the keys',
      breakStartsAt: new Date(2026, 10, 18, 12, 0).toISOString(),
      breakEndsAt: new Date(2026, 10, 18, 12, 30).toISOString(),
    });
    renderPanel();

    expect(screen.getAllByText('Cashier').length).toBeGreaterThan(0);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Bring the keys')).toBeInTheDocument();
    expect(screen.getByText(/12:00/)).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('opens the employee on top of the shift', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Ann Archer' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'hr_employee', id: 'hremp_ann', stack: true });
  });

  it('shows placeholders while the schedule loads, and says so when the shift is gone', () => {
    loadedShift = undefined;
    const { unmount } = renderPanel();
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    unmount();

    loadedShift = null;
    renderPanel();
    expect(screen.queryByText('Ann Archer')).not.toBeInTheDocument();
    expect(screen.getByText(/not found|no longer|doesn.t exist/i)).toBeInTheDocument();
  });

  it('offers only Edit to a member who may not delete', async () => {
    permissions.add('attendance:update');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: /Edit/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /Edit/ }));
    expect(screen.getByRole('dialog', { name: 'Shift editor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete from the editor' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close the editor' }));
    expect(screen.queryByRole('dialog', { name: 'Shift editor' })).not.toBeInTheDocument();
  });

  it('deletes the shift after asking, and closes the panel', async () => {
    permissions.add('attendance:delete');
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPanel(onClose);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: /Edit/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog', { name: /Delete/ });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(deleteAsync).toHaveBeenCalledWith('shift_1');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says so when deleting fails, and the dialog can be dismissed', async () => {
    permissions.add('attendance:delete');
    deleteAsync.mockRejectedValue(new Error('In use'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPanel(onClose);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog', { name: /Delete/ });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('In use'));
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: /Delete/ })).not.toBeInTheDocument());
  });

  it('offers Delete in the editor of a member who may delete', async () => {
    permissions.add('attendance:update');
    permissions.add('attendance:delete');
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit/ }));
    await user.click(screen.getByRole('button', { name: 'Delete from the editor' }));
    expect(await screen.findByRole('dialog', { name: /Delete/ })).toBeInTheDocument();
  });
});
