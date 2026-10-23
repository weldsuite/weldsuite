import { accountForCategory, expenseAccounts } from '@/lib/expense-category';
import type { GlAccount } from '@/types/accounting';

function chart(rows: [string, string][], type: GlAccount['type'] = 'expense'): GlAccount[] {
  return rows.map(([code, name]) => ({ id: `acc_${code}`, code, name, type, isActive: true }));
}

const NL = chart([
  ['4110', 'Lonen en salarissen'],
  ['4220', 'Gas, water, elektra'],
  ['4300', 'Kantoorkosten'],
  ['4310', 'Kantoorbenodigdheden'],
  ['4410', 'Autokosten'],
  ['4420', 'Reiskosten'],
  ['4520', 'Representatiekosten'],
  ['4600', 'Algemene kosten'],
  ['4610', 'Verzekeringen'],
]);

const US = chart([
  ['6010', 'Car and truck expenses'],
  ['6080', 'Insurance'],
  ['6110', 'Office expenses'],
  ['6160', 'Supplies'],
  ['6180', 'Travel'],
  ['6185', 'Meals'],
  ['6195', 'Utilities'],
]);

describe('accountForCategory', () => {
  it('finds each category in the Dutch chart', () => {
    expect(accountForCategory('food', NL)?.code).toBe('4520');
    expect(accountForCategory('transport', NL)?.code).toBe('4410');
    expect(accountForCategory('office', NL)?.code).toBe('4300');
    expect(accountForCategory('travel', NL)?.code).toBe('4420');
    expect(accountForCategory('supplies', NL)?.code).toBe('4310');
    expect(accountForCategory('utilities', NL)?.code).toBe('4220');
    expect(accountForCategory('insurance', NL)?.code).toBe('4610');
    expect(accountForCategory('other', NL)?.code).toBe('4600');
  });

  it('finds each category in the US chart', () => {
    expect(accountForCategory('food', US)?.code).toBe('6185');
    expect(accountForCategory('transport', US)?.code).toBe('6010');
    expect(accountForCategory('office', US)?.code).toBe('6110');
    expect(accountForCategory('travel', US)?.code).toBe('6180');
    expect(accountForCategory('supplies', US)?.code).toBe('6160');
    expect(accountForCategory('utilities', US)?.code).toBe('6195');
    expect(accountForCategory('insurance', US)?.code).toBe('6080');
  });

  it('leaves the default to the server when nothing matches', () => {
    expect(accountForCategory('other', US)).toBeNull();
    expect(accountForCategory('office', [])).toBeNull();
  });

  it('never picks an inactive or non-expense account', () => {
    const accounts = [
      ...chart([['1550', 'Office equipment']], 'asset'),
      { ...chart([['4300', 'Kantoorkosten']])[0], isActive: false },
    ];
    expect(accountForCategory('office', accounts)).toBeNull();
  });
});

describe('expenseAccounts', () => {
  it('lists the active expense accounts by code', () => {
    const accounts = [...chart([['6110', 'Office expenses'], ['600', 'Rent']]), ...chart([['1000', 'Bank']], 'asset')];
    expect(expenseAccounts(accounts).map((account) => account.code)).toEqual(['600', '6110']);
  });
});
