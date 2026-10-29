import { filterChoices, isFiltered, NO_FILTER, passesFilter, toggled } from '../expense-filter';

const train = { status: 'paid', category: 'travel' } as const;
const lunch = { status: 'pending', category: 'meals' } as const;
const laptop = { status: 'rejected', category: 'equipment' } as const;

describe('passesFilter', () => {
  it('lets everything through with every switch on', () => {
    expect([train, lunch, laptop].every((row) => passesFilter(NO_FILTER, row))).toBe(true);
    expect(isFiltered(NO_FILTER)).toBe(false);
  });

  it('hides the statuses switched off', () => {
    const filter = { statuses: [lunch.status, train.status], categories: [] };
    expect(isFiltered(filter)).toBe(true);
    expect(passesFilter(filter, lunch)).toBe(false);
    expect(passesFilter(filter, train)).toBe(false);
    expect(passesFilter(filter, laptop)).toBe(true);
  });

  it('hides the categories switched off', () => {
    const filter = { statuses: [], categories: [train.category] };
    expect(passesFilter(filter, train)).toBe(false);
    expect(passesFilter(filter, lunch)).toBe(true);
  });
});

describe('toggled', () => {
  it('puts a value in once and takes it out again', () => {
    expect(toggled(['meals'], 'travel', true)).toEqual(['meals', 'travel']);
    expect(toggled(['meals', 'travel'], 'travel', true)).toEqual(['meals', 'travel']);
    expect(toggled(['meals', 'travel'], 'meals', false)).toEqual(['travel']);
  });
});

describe('filterChoices', () => {
  it('offers only what the list has, in sheet order', () => {
    expect(filterChoices([laptop, train, lunch], NO_FILTER)).toEqual({
      statuses: ['pending', 'paid', 'rejected'],
      categories: ['travel', 'meals', 'equipment'],
    });
  });

  it('keeps a switch that is off even when no claim has it any more', () => {
    const { statuses, categories } = filterChoices([train], { statuses: ['cancelled'], categories: ['training'] });
    expect(statuses).toEqual(['paid', 'cancelled']);
    expect(categories).toEqual(['travel', 'training']);
  });
});
