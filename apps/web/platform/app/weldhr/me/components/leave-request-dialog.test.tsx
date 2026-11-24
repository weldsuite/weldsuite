import { createContext, useContext, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { LeaveRequestDialog } from './leave-request-dialog';

const mocks = vi.hoisted(() => ({ request: vi.fn(), toastSuccess: vi.fn(), onClose: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: (message: string) => mocks.toastSuccess(message), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrRequestLeave: () => ({ mutateAsync: mocks.request, isPending: false }),
}));
vi.mock('@/app/weldhr/components/date-fields', () => ({
  HrDateInput: ({ value, onChange, min, name }: { value?: string; onChange: (value: string) => void; min?: string; name?: string }) => (
    <input type="date" aria-label={name} value={value ?? ''} min={min} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('@weldsuite/ui/components/select', () => {
  const Pick = createContext<(value: string) => void>(() => undefined);
  return {
    Select: ({ children, onValueChange }: { children: ReactNode; onValueChange: (value: string) => void }) => (
      <Pick.Provider value={onValueChange}>{children}</Pick.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>,
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: function SelectItem({ children, value }: { children: ReactNode; value: string }) {
      const pick = useContext(Pick);
      return (
        <button type="button" onClick={() => pick(value)}>
          {children}
        </button>
      );
    },
  };
});

const types: HrSelfLeave['types'] = [
  { id: 'lt_annual', name: 'Annual leave', color: '#22aa55', requiresApproval: true },
  { id: 'lt_study', name: 'Study day', color: null, requiresApproval: false },
];

function renderDialog() {
  return render(
    <I18nProvider initialLanguage="en">
      <LeaveRequestDialog types={types} onClose={mocks.onClose} />
    </I18nProvider>,
  );
}

async function pickType(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name }));
}

beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue(undefined);
  mocks.toastSuccess.mockReset();
  mocks.onClose.mockReset();
});

describe('LeaveRequestDialog', () => {
  it('keeps Submit disabled until a leave type is picked, and explains how it is approved', async () => {
    const user = userEvent.setup();
    renderDialog();

    const submit = screen.getByRole('button', { name: 'Submit request' });
    await waitFor(() => expect(submit).toBeDisabled());

    await pickType(user, 'Annual leave');
    expect(await screen.findByText('This leave type needs approval from your HR team.')).toBeInTheDocument();
    await waitFor(() => expect(submit).toBeEnabled());

    await pickType(user, 'Study day');
    expect(await screen.findByText('This leave type is approved automatically.')).toBeInTheDocument();
  });

  it('requests leave with the trimmed reason and closes', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pickType(user, 'Annual leave');
    fireEvent.change(screen.getByLabelText('startDate'), { target: { value: '2026-12-21' } });
    fireEvent.change(screen.getByLabelText('endDate'), { target: { value: '2026-12-24' } });
    await user.type(screen.getByRole('textbox'), '  Christmas  ');
    const submit = screen.getByRole('button', { name: 'Submit request' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        leaveTypeId: 'lt_annual',
        startDate: '2026-12-21',
        endDate: '2026-12-24',
        reason: 'Christmas',
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Leave requested');
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('sends no reason when it is blank, and rejects an end date before the start', async () => {
    const user = userEvent.setup();
    renderDialog();

    await pickType(user, 'Annual leave');
    fireEvent.change(screen.getByLabelText('startDate'), { target: { value: '2026-12-21' } });
    fireEvent.change(screen.getByLabelText('endDate'), { target: { value: '2026-12-01' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit request' })).toBeDisabled());
    expect(screen.getByLabelText('endDate')).toHaveAttribute('min', '2026-12-21');

    fireEvent.change(screen.getByLabelText('endDate'), { target: { value: '2026-12-22' } });
    const submit = screen.getByRole('button', { name: 'Submit request' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ reason: null })));
  });

  it('says so when the request overlaps another, and shows other failures as they are', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Request would Overlap an existing one'));
    const user = userEvent.setup();
    renderDialog();

    await pickType(user, 'Annual leave');
    const submit = screen.getByRole('button', { name: 'Submit request' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('This overlaps another leave request of yours.')).toBeInTheDocument();
    expect(mocks.onClose).not.toHaveBeenCalled();

    mocks.request.mockRejectedValueOnce(new Error('Server on fire'));
    await user.click(submit);
    expect(await screen.findByText('Server on fire')).toBeInTheDocument();
  });

  it('closes from Cancel', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.onClose).toHaveBeenCalled();
  });

  it('closes from Escape', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.keyboard('{Escape}');
    expect(mocks.onClose).toHaveBeenCalled();
  });
});
