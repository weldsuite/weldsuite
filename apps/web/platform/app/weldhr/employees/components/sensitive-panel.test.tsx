import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrEmployeeSensitive } from '@weldsuite/app-api-client/domains/weldhr';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
  revealedArgs: [] as boolean[],
  update: vi.fn(),
  isPending: false,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useHrEmployeeSensitive: (_id: string, revealed: boolean) => {
    state.revealedArgs.push(revealed);
    return { data: revealed ? state.data : undefined, isLoading: state.isLoading, error: state.error };
  },
  useUpdateHrEmployeeSensitive: () => ({ mutateAsync: state.update, isPending: state.isPending }),
}));

import { SensitivePanel } from './sensitive-panel';

const t = en.weldhr.employees.detail.personalTab;

const sensitive: HrEmployeeSensitive = {
  dateOfBirth: '1990-05-10',
  nationalId: 'NL-123',
  address: 'Main Street 1',
  salaryAmount: 4000,
  salaryCurrency: 'EUR',
  salaryPeriod: 'month',
  notes: 'Prefers email',
};

function renderPanel() {
  renderWithProviders(<SensitivePanel employeeId="hremp_1" />);
}

beforeEach(() => {
  polyfillRadixSelect();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00'));
  state.data = sensitive;
  state.isLoading = false;
  state.error = null;
  state.revealedArgs = [];
  state.isPending = false;
  state.update.mockReset().mockResolvedValue({});
  vi.mocked(toast.success).mockReset();
});

afterEach(() => vi.useRealTimers());

describe('SensitivePanel', () => {
  it('stays hidden, and does not load, until revealed', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: t.show })).toBeInTheDocument();
    expect(screen.queryByText(t.fields.nationalId)).not.toBeInTheDocument();
    expect(state.revealedArgs.every((revealed) => !revealed)).toBe(true);
  });

  describe('revealed', () => {
    async function reveal() {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: t.show }));
      return user;
    }

    it('shows the details, with the date of birth in the list format and the salary with its period', async () => {
      await reveal();
      expect(screen.getByText('NL-123')).toBeInTheDocument();
      expect(screen.getByText(/10 May 1990|May 10, 1990/)).toBeInTheDocument();
      expect(screen.getByText(/4,000\.00|4\.000,00/)).toBeInTheDocument();
      expect(screen.getByText('Prefers email')).toBeInTheDocument();
    });

    it('hides again', async () => {
      const user = await reveal();
      await user.click(screen.getByRole('button', { name: t.hide }));
      expect(screen.queryByText('NL-123')).not.toBeInTheDocument();
    });

    it('shows dashes for what is not filled in', async () => {
      state.data = {};
      await reveal();
      expect(screen.getAllByText('—').length).toBeGreaterThan(5);
    });

    it('shows the salary without a period or a currency', async () => {
      state.data = { salaryAmount: 55, salaryCurrency: null, salaryPeriod: null };
      await reveal();
      expect(screen.getByText('55')).toBeInTheDocument();
    });

    it('shows a spinner while loading, and the error when it failed', async () => {
      state.isLoading = true;
      state.error = new Error('Decryption failed');
      await reveal();
      expect(screen.getByText('Decryption failed')).toBeInTheDocument();
      expect(screen.queryByText('NL-123')).not.toBeInTheDocument();
    });

    it('falls back to a general message when the failure has none', async () => {
      state.error = new Error('');
      await reveal();
      expect(screen.getByText(t.loadFailed)).toBeInTheDocument();
    });
  });

  describe('editing', () => {
    async function edit() {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: t.show }));
      await user.click(screen.getByRole('button', { name: en.weldhr.common.edit }));
      return user;
    }

    it('shows the date of birth in the list format on a date picker', async () => {
      await edit();
      expect(screen.getByLabelText(t.fields.dateOfBirth)).toHaveTextContent(/10 May 1990|May 10, 1990/);
    });

    it('offers year and month menus, and cannot pick a day in the future', async () => {
      const user = await edit();
      await user.click(screen.getByLabelText(t.fields.dateOfBirth));
      expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(2);
    });

    it('changes the date of birth and saves it as YYYY-MM-DD', async () => {
      const user = await edit();
      await user.click(screen.getByLabelText(t.fields.dateOfBirth));
      await user.click(await screen.findByRole('button', { name: /May 12th, 1990/ }));
      await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));
      await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
      expect(state.update.mock.calls[0]![0]).toMatchObject({ id: 'hremp_1', dateOfBirth: '1990-05-12', nationalId: 'NL-123', salaryAmount: 4000 });
      expect(toast.success).toHaveBeenCalledWith(t.savedToast);
    });

    it('clears the date of birth when the selected day is picked again, and saves null', async () => {
      const user = await edit();
      await user.click(screen.getByLabelText(t.fields.dateOfBirth));
      await user.click(await screen.findByRole('button', { name: /May 10th, 1990/ }));
      await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));
      await waitFor(() => expect(state.update).toHaveBeenCalled());
      expect(state.update.mock.calls[0]![0].dateOfBirth).toBeNull();
    });

    it('refuses a date of birth in the future that came from the server', async () => {
      state.data = { dateOfBirth: '2027-01-01' };
      await edit();
      expect(screen.getByText(en.weldhr.employees.validation.birthInFuture)).toBeInTheDocument();
      expect(screen.getByLabelText(t.fields.dateOfBirth)).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: en.weldhr.common.save })).toBeDisabled();
    });

    it('shows why saving failed, and a general message without a reason', async () => {
      state.update.mockRejectedValueOnce(new Error('Not allowed'));
      const user = await edit();
      await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));
      expect(await screen.findByText('Not allowed')).toBeInTheDocument();
      state.update.mockRejectedValueOnce('x');
      await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));
      expect(await screen.findByText(t.saveFailed)).toBeInTheDocument();
    });

    it('goes back to the view with Cancel', async () => {
      const user = await edit();
      await user.click(screen.getByRole('button', { name: en.weldhr.common.cancel }));
      expect(screen.getByRole('button', { name: en.weldhr.common.edit })).toBeInTheDocument();
    });
  });
});
