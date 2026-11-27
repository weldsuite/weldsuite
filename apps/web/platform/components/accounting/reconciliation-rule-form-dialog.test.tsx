import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  processing: false,
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateReconciliationRule: () => ({ mutate: env.create, isPending: false, error: null }),
  useUpdateReconciliationRule: () => ({ mutate: env.update, isPending: false, error: null }),
  useAccountingAccounts: () => ({
    data: { data: [{ id: 'acc_tel', code: '4100', name: 'Telephone', type: 'expense' }] },
  }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'VAT 21%', rate: '21' }] } }),
  useAccountingCustomers: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({ data: { data: [{ id: 'ba_1', name: 'ING Business' }, { id: 'ba_2', name: 'Savings' }] } }),
}));
vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({
  isBankProcessingAvailable: () => env.processing,
}));

import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/banking/components/test-utils';
import { ReconciliationRuleFormDialog } from './reconciliation-rule-form-dialog';

function renderDialog(props: Partial<React.ComponentProps<typeof ReconciliationRuleFormDialog>> = {}) {
  return renderWithProviders(<ReconciliationRuleFormDialog open onOpenChange={vi.fn()} {...props} />);
}

async function fieldOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Condition 1: field' }));
  return (await screen.findAllByRole('option')).map((option) => option.textContent);
}

describe('ReconciliationRuleFormDialog conditions', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.processing = false;
    env.create.mockReset();
    env.update.mockReset();
  });

  it('offers only the conditions both backends know where the edition lacks bank processing', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(await fieldOptions(user)).toEqual(['Description', 'Counterparty name', 'Counterparty IBAN', 'Reference', 'Amount']);
  });

  it('adds Direction and Bank account where the edition has bank processing', async () => {
    env.processing = true;
    const user = userEvent.setup();
    renderDialog();
    expect(await fieldOptions(user)).toEqual([
      'Description',
      'Counterparty name',
      'Counterparty IBAN',
      'Reference',
      'Amount',
      'Direction',
      'Bank account',
    ]);
  });

  it('saves a direction condition as money in or out, equals only', async () => {
    env.processing = true;
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'Incoming');
    await user.click(screen.getByRole('combobox', { name: 'Condition 1: field' }));
    await user.click(await screen.findByRole('option', { name: 'Direction' }));

    // The operator can only be "equals", the value is a choice of in or out.
    await user.click(screen.getByRole('combobox', { name: 'Condition 1: operator' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['equals']);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('combobox', { name: 'Condition 1: value' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Money in', 'Money out']);
    await user.click(screen.getByRole('option', { name: 'Money in' }));

    await user.click(screen.getByRole('combobox', { name: 'Category account' }));
    await user.click(await screen.findByRole('option', { name: /Telephone/ }));
    await user.click(screen.getByRole('button', { name: 'Create rule' }));

    expect(env.create).toHaveBeenCalledTimes(1);
    expect(env.create.mock.calls[0]![0]).toMatchObject({
      name: 'Incoming',
      conditions: [{ field: 'direction', operator: 'equals', value: 'in' }],
      actions: { categoryAccountId: 'acc_tel' },
    });
  });

  it('saves a bank account condition with the account id', async () => {
    env.processing = true;
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('Name'), 'Savings only');
    await user.click(screen.getByRole('combobox', { name: 'Condition 1: field' }));
    await user.click(await screen.findByRole('option', { name: 'Bank account' }));
    await user.click(screen.getByRole('combobox', { name: 'Condition 1: value' }));
    await user.click(await screen.findByRole('option', { name: 'Savings' }));
    await user.click(screen.getByRole('combobox', { name: 'Category account' }));
    await user.click(await screen.findByRole('option', { name: /Telephone/ }));
    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    expect(env.create.mock.calls[0]![0]).toMatchObject({
      conditions: [{ field: 'bankAccountId', operator: 'equals', value: 'ba_2' }],
    });
  });

  it('starts from a pre-fill (the rule suggestion) and reports the saved rule', async () => {
    env.processing = true;
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    env.create.mockImplementation((_payload: unknown, options: { onSuccess: (res: unknown) => void }) =>
      options.onSuccess({ data: { id: 'rr_new', name: 'Telnet Zakelijk' } }),
    );
    renderDialog({
      onCreated,
      onOpenChange,
      prefill: {
        name: 'Telnet Zakelijk',
        matchMode: 'all',
        conditions: [
          { field: 'counterpartyIban', operator: 'equals', value: 'NL20INGB0001234567' },
          { field: 'direction', operator: 'equals', value: 'out' },
        ],
        actions: { categoryAccountId: 'acc_tel', taxRateId: 'tax_21' },
      },
    });
    expect(screen.getByLabelText('Name')).toHaveValue('Telnet Zakelijk');
    expect(screen.getByDisplayValue('NL20INGB0001234567')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Condition 2: value' })).toHaveTextContent('Money out');
    expect(screen.getByRole('combobox', { name: 'Category account' })).toHaveTextContent('4100 — Telephone');

    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    expect(env.create.mock.calls[0]![0]).toMatchObject({
      name: 'Telnet Zakelijk',
      matchMode: 'all',
      actions: { categoryAccountId: 'acc_tel', taxRateId: 'tax_21' },
    });
    expect(onCreated).toHaveBeenCalledWith({ id: 'rr_new', name: 'Telnet Zakelijk' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the conditions of a pre-fill in their own rows', () => {
    renderDialog({
      prefill: {
        name: 'x',
        matchMode: 'all',
        conditions: [
          { field: 'counterpartyName', operator: 'equals', value: 'Acme' },
          { field: 'counterpartyIban', operator: 'equals', value: 'NL91' },
        ],
        actions: { categoryAccountId: 'acc_tel' },
      },
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('textbox', { name: /value/ })).toHaveLength(2);
  });
});
