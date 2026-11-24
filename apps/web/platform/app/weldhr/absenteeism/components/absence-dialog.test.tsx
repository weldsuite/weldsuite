import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrAbsence } from '@weldsuite/app-api-client/domains/weldhr';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  reportSick: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  pending: { reportSick: false, create: false, update: false },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/shared')>()),
  EmployeePicker: ({
    valueLabel,
    disabled,
    onChange,
  }: {
    valueLabel: string | null;
    disabled?: boolean;
    onChange: (id: string | null, label: string | null) => void;
  }) => (
    <div>
      <span data-testid="employee-label">{valueLabel}</span>
      <button type="button" disabled={disabled} onClick={() => onChange('emp_anna', 'Anna de Vries')}>
        pick employee
      </button>
      <button type="button" disabled={disabled} onClick={() => onChange(null, null)}>
        clear employee
      </button>
    </div>
  ),
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrReportSick: () => ({ mutateAsync: state.reportSick, isPending: state.pending.reportSick }),
  useCreateHrAbsence: () => ({ mutateAsync: state.create, isPending: state.pending.create }),
  useUpdateHrAbsence: () => ({ mutateAsync: state.update, isPending: state.pending.update }),
}));

import { AbsenceDialog } from './absence-dialog';

const t = en.weldhr.absenteeism.form;

const absence: HrAbsence = {
  id: 'abs_1',
  employeeId: 'emp_bram',
  employeeName: 'Bram Jansen',
  departmentName: null,
  startDate: '2026-11-16',
  endDate: '2026-11-18',
  firstDay: 'half',
  note: 'Flu',
  status: 'completed',
  days: 2.5,
  relapse: false,
  reportedBySelf: false,
  reportedByName: 'HR',
  recoveredReportedAt: null,
  createdAt: '2026-11-16T09:00:00Z',
} as HrAbsence;

type Mode = Parameters<typeof AbsenceDialog>[0]['mode'];

function renderDialog(mode: Mode) {
  const onClose = vi.fn();
  renderWithProviders(<AbsenceDialog mode={mode} onClose={onClose} />);
  return { onClose };
}

beforeEach(() => {
  polyfillRadixSelect();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  for (const fn of [state.reportSick, state.create, state.update]) fn.mockReset().mockResolvedValue({});
  state.pending = { reportSick: false, create: false, update: false };
  vi.mocked(toast.success).mockReset();
});

afterEach(() => vi.useRealTimers());

describe('AbsenceDialog', () => {
  describe('self', () => {
    it('has no employee or last-day field, and starts today', () => {
      renderDialog({ kind: 'self' });
      expect(screen.getByRole('heading', { name: t.reportTitle })).toBeInTheDocument();
      expect(screen.queryByText('pick employee')).not.toBeInTheDocument();
      expect(screen.queryByText(t.lastSickDay)).not.toBeInTheDocument();
      expect(screen.getByLabelText(t.firstSickDay)).toHaveTextContent(/23/);
      expect(screen.getByText(t.noteHint)).toBeInTheDocument();
    });

    it('is ready to submit as soon as it opens, and reports the sick day', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const { onClose } = renderDialog({ kind: 'self' });
      const submit = screen.getByRole('button', { name: t.submit });
      await waitFor(() => expect(submit).toBeEnabled());
      await user.type(screen.getByRole('textbox'), '  Fever  ');
      await user.click(submit);
      await waitFor(() => expect(state.reportSick).toHaveBeenCalledTimes(1));
      expect(state.reportSick.mock.calls[0]![0]).toMatchObject({ firstDay: 'full', note: 'Fever' });
      expect(toast.success).toHaveBeenCalledWith(t.reportedToast);
      expect(onClose).toHaveBeenCalled();
    });

    it('cannot pick a day in the future', async () => {
      // Keeps the fixed date (Monday 23 November 2026), so the 24th is tomorrow on any day the test runs.
      const user = userEvent.setup();
      renderDialog({ kind: 'self' });
      await user.click(screen.getByLabelText(t.firstSickDay));
      const tomorrow = await screen.findByRole('button', { name: /Tuesday, November 24th, 2026/ });
      expect(tomorrow).toBeDisabled();
    });

    it('sends no note when it is blank', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderDialog({ kind: 'self' });
      await waitFor(() => expect(screen.getByRole('button', { name: t.submit })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.submit }));
      await waitFor(() => expect(state.reportSick).toHaveBeenCalled());
      expect(state.reportSick.mock.calls[0]![0].note).toBeNull();
    });
  });

  describe('create', () => {
    it('keeps Submit disabled until an employee is picked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderDialog({ kind: 'create' });
      expect(screen.getByRole('button', { name: t.submit })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'pick employee' }));
      expect(screen.getByTestId('employee-label')).toHaveTextContent('Anna de Vries');
      await waitFor(() => expect(screen.getByRole('button', { name: t.submit })).toBeEnabled());

      await user.click(screen.getByRole('button', { name: 'clear employee' }));
      expect(screen.getByTestId('employee-label')).toBeEmptyDOMElement();
      await waitFor(() => expect(screen.getByRole('button', { name: t.submit })).toBeDisabled());
    });

    it('files the report for the employee, with an open end', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const { onClose } = renderDialog({ kind: 'create' });
      await user.click(screen.getByRole('button', { name: 'pick employee' }));
      await waitFor(() => expect(screen.getByRole('button', { name: t.submit })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.submit }));
      await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
      expect(state.create.mock.calls[0]![0]).toMatchObject({ employeeId: 'emp_anna', endDate: null, firstDay: 'full' });
      expect(onClose).toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('disables the days before the first sick day on the last-day field', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderDialog({ kind: 'create' });
      await user.click(screen.getByLabelText(t.lastSickDay));
      expect(await screen.findByRole('button', { name: /November 22nd, 2026/ })).toBeDisabled();
    });

    it('allows a future first sick day for HR', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderDialog({ kind: 'create' });
      await user.click(screen.getByLabelText(t.firstSickDay));
      expect(await screen.findByRole('button', { name: /November 30th, 2026/ })).toBeEnabled();
    });

    it('shows a translated line when the employee already has an open report', async () => {
      vi.useRealTimers();
      state.create.mockRejectedValue(new Error('Employee has already an open report'));
      const user = userEvent.setup();
      const { onClose } = renderDialog({ kind: 'create' });
      await user.click(screen.getByRole('button', { name: 'pick employee' }));
      await waitFor(() => expect(screen.getByRole('button', { name: t.submit })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.submit }));
      expect(await screen.findByText(t.alreadyOpen)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('edit', () => {
    it('starts from the report with the employee fixed', async () => {
      renderDialog({ kind: 'edit', absence });
      expect(screen.getByRole('heading', { name: t.editTitle })).toBeInTheDocument();
      expect(screen.getByTestId('employee-label')).toHaveTextContent('Bram Jansen');
      expect(screen.getByRole('button', { name: 'pick employee' })).toBeDisabled();
      expect(screen.getByLabelText(t.firstSickDay)).toHaveTextContent(/16/);
      expect(screen.getByLabelText(t.lastSickDay)).toHaveTextContent(/18/);
      expect(screen.getByDisplayValue('Flu')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: t.save })).toBeEnabled());
    });

    it('saves the correction', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const { onClose } = renderDialog({ kind: 'edit', absence });
      await waitFor(() => expect(screen.getByRole('button', { name: t.save })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.save }));
      await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
      expect(state.update.mock.calls[0]![0]).toMatchObject({
        id: 'abs_1',
        startDate: '2026-11-16',
        endDate: '2026-11-18',
        firstDay: 'half',
        note: 'Flu',
      });
      expect(onClose).toHaveBeenCalled();
    });

    it('keeps an open report open when saving', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderDialog({ kind: 'edit', absence: { ...absence, endDate: null } });
      await waitFor(() => expect(screen.getByRole('button', { name: t.save })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: t.save }));
      await waitFor(() => expect(state.update).toHaveBeenCalled());
      expect(state.update.mock.calls[0]![0].endDate).toBeNull();
    });

    it('disables Save for a last day before the first day', async () => {
      renderDialog({ kind: 'edit', absence: { ...absence, endDate: '2026-11-10' } });
      await waitFor(() => expect(screen.getByRole('button', { name: t.save })).toBeDisabled());
    });

    it('shows Saving and cannot be cancelled while saving', () => {
      state.pending.update = true;
      renderDialog({ kind: 'edit', absence });
      expect(screen.getByRole('button', { name: t.saving })).toBeDisabled();
      expect(screen.getByRole('button', { name: en.weldhr.common.cancel })).toBeDisabled();
    });
  });

  it('shows Submitting while a report is being filed', () => {
    state.pending.create = true;
    renderDialog({ kind: 'create' });
    expect(screen.getByRole('button', { name: t.submitting })).toBeDisabled();
  });

  it('closes with Cancel', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { onClose } = renderDialog({ kind: 'self' });
    await user.click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
    expect(onClose).toHaveBeenCalled();
  });
});
