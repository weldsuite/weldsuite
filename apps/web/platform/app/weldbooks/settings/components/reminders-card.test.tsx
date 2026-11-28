import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setRuntimeConfig } from '@/lib/runtime-config';

const env = vi.hoisted(() => ({
  canEdit: true,
  toast: { success: vi.fn(), error: vi.fn() },
  salesApi: { getReminderSettings: vi.fn(), updateReminderSettings: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canEdit }));
vi.mock('@/lib/api/domains/weldbooks-sales', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/domains/weldbooks-sales')>()),
  salesApi: env.salesApi,
}));

import { RemindersCard, reminderProblem } from './reminders-card';
import { polyfillRadixSelect, renderWithProviders } from '../../invoices/components/test-utils';

const RUST = { backend: 'rust', modules: ['core', 'books'], unavailableFeatures: [] as string[] };

const settings = (overrides: Record<string, unknown> = {}) => ({
  data: {
    enabled: true,
    entityId: 'ent_1',
    statutoryAvailable: true,
    defaultRates: { commercialRate: 10.4, consumerRate: 4 },
    statutoryCosts: { enabled: false, interest: false, commercialRate: 10.4, consumerRate: 4 },
    steps: [
      { level: 1, daysAfterDue: 7, auto: true, template: 'reminder1', final: false },
      { level: 2, daysAfterDue: 21, auto: true, template: 'reminder2', final: false },
      { level: 3, daysAfterDue: 35, auto: false, template: 'reminder3', final: true },
    ],
    ...overrides,
  },
});

describe('RemindersCard', () => {
  beforeEach(() => {
    polyfillRadixSelect();
    setRuntimeConfig(RUST);
    env.canEdit = true;
    env.salesApi.getReminderSettings.mockReset();
    env.salesApi.updateReminderSettings.mockReset();
    env.salesApi.getReminderSettings.mockResolvedValue(settings());
    env.toast.success.mockReset();
    env.toast.error.mockReset();
  });
  afterEach(() => setRuntimeConfig(null));

  async function renderCard() {
    const utils = renderWithProviders(<RemindersCard />);
    await screen.findByTestId('reminder-step-1');
    return utils;
  }

  it('shows the workflow with its three steps', async () => {
    await renderCard();
    expect(screen.getByRole('switch', { name: 'Send payment reminders' })).toBeChecked();
    expect(within(screen.getByTestId('reminder-step-1')).getByLabelText('Days after the due date')).toHaveValue(7);
    expect(within(screen.getByTestId('reminder-step-2')).getByLabelText('Days after the due date')).toHaveValue(21);
    expect(within(screen.getByTestId('reminder-step-3')).getByRole('switch', { name: 'This is the final notice' })).toBeChecked();
    expect(within(screen.getByTestId('reminder-step-3')).getByRole('combobox', { name: 'How' })).toHaveTextContent('Ask me in To process');
  });

  it('saves nothing until something changed', async () => {
    await renderCard();
    expect(screen.getByRole('button', { name: 'Save reminders' })).toBeDisabled();
  });

  it('saves the changed workflow: days, how and the final notice', async () => {
    const user = userEvent.setup();
    env.salesApi.updateReminderSettings.mockResolvedValue(settings());
    await renderCard();
    const first = screen.getByTestId('reminder-step-1');
    const days = within(first).getByLabelText('Days after the due date');
    await user.clear(days);
    await user.type(days, '10');
    await user.click(within(screen.getByTestId('reminder-step-2')).getByRole('switch', { name: 'This is the final notice' }));
    await user.click(screen.getByRole('button', { name: 'Save reminders' }));
    await waitFor(() => expect(env.salesApi.updateReminderSettings).toHaveBeenCalledTimes(1));
    const sent = env.salesApi.updateReminderSettings.mock.calls[0][0];
    expect(sent.enabled).toBe(true);
    expect(sent.steps.map((step: { daysAfterDue: number; final: boolean }) => [step.daysAfterDue, step.final])).toEqual([
      [10, false],
      [21, true],
      // Only one step is the final notice: choosing another takes it from the last.
      [35, false],
    ]);
    expect(sent.statutoryCosts).toEqual({ enabled: false, interest: false, commercialRate: 10.4, consumerRate: 4 });
    expect(env.toast.success).toHaveBeenCalledWith('Reminder settings saved');
  });

  it('turns the whole workflow off', async () => {
    const user = userEvent.setup();
    env.salesApi.updateReminderSettings.mockResolvedValue(settings({ enabled: false }));
    await renderCard();
    await user.click(screen.getByRole('switch', { name: 'Send payment reminders' }));
    await user.click(screen.getByRole('button', { name: 'Save reminders' }));
    await waitFor(() => expect(env.salesApi.updateReminderSettings.mock.calls[0][0].enabled).toBe(false));
  });

  it('says each step must come later than the one before, and holds Save back', async () => {
    const user = userEvent.setup();
    await renderCard();
    const second = within(screen.getByTestId('reminder-step-2')).getByLabelText('Days after the due date');
    await user.clear(second);
    await user.type(second, '5');
    expect(screen.getByRole('alert')).toHaveTextContent('Each step must come later than the one before it.');
    expect(screen.getByRole('button', { name: 'Save reminders' })).toBeDisabled();
  });

  it('discards changes', async () => {
    const user = userEvent.setup();
    await renderCard();
    const first = within(screen.getByTestId('reminder-step-1')).getByLabelText('Days after the due date');
    await user.clear(first);
    await user.type(first, '9');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(first).toHaveValue(7);
  });

  describe('Statutory collection costs (WIK)', () => {
    it('explains B2B and B2C in plain words and has the costs off by default', async () => {
      await renderCard();
      const section = screen.getByTestId('wik-section');
      expect(within(section).getByText('Statutory collection costs (WIK)')).toBeInTheDocument();
      expect(section).toHaveTextContent('Business customers: collection costs and the commercial interest rate can be asked right away.');
      expect(section).toHaveTextContent('Consumers: only after a notice of 14 days.');
      expect(within(section).getByRole('switch', { name: 'Add collection costs to the final notice' })).not.toBeChecked();
      expect(within(section).queryByLabelText('Commercial interest, % a year')).not.toBeInTheDocument();
    });

    it('shows the editable rates with the statutory defaults once switched on, and saves them', async () => {
      const user = userEvent.setup();
      env.salesApi.updateReminderSettings.mockResolvedValue(settings());
      await renderCard();
      const section = screen.getByTestId('wik-section');
      await user.click(within(section).getByRole('switch', { name: 'Add collection costs to the final notice' }));
      await user.click(within(section).getByRole('switch', { name: 'Also add statutory interest' }));
      expect(within(section).getByLabelText('Commercial interest, % a year')).toHaveValue('10.4');
      expect(section).toHaveTextContent('Current statutory rate: 10.4%');
      expect(section).toHaveTextContent('Current statutory rate: 4%');
      const commercial = within(section).getByLabelText('Commercial interest, % a year');
      await user.clear(commercial);
      await user.type(commercial, '9,5');
      await user.click(screen.getByRole('button', { name: 'Save reminders' }));
      await waitFor(() =>
        expect(env.salesApi.updateReminderSettings.mock.calls[0][0].statutoryCosts).toEqual({
          enabled: true,
          interest: true,
          commercialRate: 9.5,
          consumerRate: 4,
        }),
      );
    });

    it('refuses a rate that is not a percentage', async () => {
      const user = userEvent.setup();
      await renderCard();
      const section = screen.getByTestId('wik-section');
      await user.click(within(section).getByRole('switch', { name: 'Add collection costs to the final notice' }));
      const consumer = within(section).getByLabelText('Statutory interest for consumers, % a year');
      await user.clear(consumer);
      await user.type(consumer, '500');
      expect(screen.getByRole('alert')).toHaveTextContent('Enter an interest rate between 0 and 100.');
      expect(screen.getByRole('button', { name: 'Save reminders' })).toBeDisabled();
    });

    it('is left out for an entity outside the Netherlands, and the save then sends no statutory costs', async () => {
      const user = userEvent.setup();
      env.salesApi.getReminderSettings.mockResolvedValue(settings({ statutoryAvailable: false }));
      env.salesApi.updateReminderSettings.mockResolvedValue(settings({ statutoryAvailable: false }));
      await renderCard();
      expect(screen.queryByTestId('wik-section')).not.toBeInTheDocument();
      await user.click(within(screen.getByTestId('reminder-step-1')).getByRole('switch', { name: 'This is the final notice' }));
      await user.click(screen.getByRole('button', { name: 'Save reminders' }));
      await waitFor(() => expect(env.salesApi.updateReminderSettings).toHaveBeenCalled());
      expect(env.salesApi.updateReminderSettings.mock.calls[0][0]).not.toHaveProperty('statutoryCosts');
    });
  });

  it('is read only for a member who may not change accounting settings', async () => {
    env.canEdit = false;
    await renderCard();
    expect(screen.getByRole('switch', { name: 'Send payment reminders' })).toBeDisabled();
    expect(screen.getByLabelText('Days after the due date', { selector: '#step-1-days' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save reminders' })).not.toBeInTheDocument();
  });

  it('says so when the settings cannot be loaded', async () => {
    env.salesApi.getReminderSettings.mockRejectedValue(new Error('down'));
    renderWithProviders(<RemindersCard />);
    expect(await screen.findByText('The reminder settings could not be loaded.')).toBeInTheDocument();
  });
});

describe('reminderProblem', () => {
  const step = (level: number, daysAfterDue: number, final = false) => ({ level, daysAfterDue, auto: true, template: `reminder${level}`, final });
  const base = { wikEnabled: false, commercialRate: '10', consumerRate: '4' };

  it('wants days that grow, whole and within a year, and a single final notice', () => {
    expect(reminderProblem({ ...base, steps: [step(1, 7), step(2, 21)] }, false)).toBeNull();
    expect(reminderProblem({ ...base, steps: [step(1, 7), step(2, 7)] }, false)).toBe('daysNotGrowing');
    expect(reminderProblem({ ...base, steps: [step(1, 400)] }, false)).toBe('daysInvalid');
    expect(reminderProblem({ ...base, steps: [step(1, 1.5)] }, false)).toBe('daysInvalid');
    expect(reminderProblem({ ...base, steps: [step(1, Number.NaN)] }, false)).toBe('daysInvalid');
    expect(reminderProblem({ ...base, steps: [step(1, 7, true), step(2, 21, true)] }, false)).toBe('twoFinal');
  });

  it('checks the rates only where the statutory costs are on and available', () => {
    const bad = { ...base, wikEnabled: true, commercialRate: 'abc', steps: [step(1, 7)] };
    expect(reminderProblem(bad, true)).toBe('rateInvalid');
    expect(reminderProblem(bad, false)).toBeNull();
    expect(reminderProblem({ ...bad, wikEnabled: false }, true)).toBeNull();
  });
});
