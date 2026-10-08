import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UsEntityTypeSummary } from '@/lib/weldbooks/us-entity';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { revealEntitySsn: vi.fn() } }));

import { UsEntityCards } from './us-entity-cards';
import { DEFAULT_US_VALUES, type UsEntityValues } from './us-entity-form';

// The server's US entry of the jurisdictions list.
const entityTypes: UsEntityTypeSummary[] = [
  {
    type: 'sole_proprietorship',
    label: 'Sole proprietorship',
    description: '',
    minOwners: 1,
    defaultClassification: 'sole_proprietor',
    classifications: [{ value: 'sole_proprietor', form: 'sch_c', formLabel: 'Schedule C (Form 1040)' }],
  },
  {
    type: 'multi_member_llc',
    label: 'LLC with two or more members',
    description: '',
    minOwners: 2,
    defaultClassification: 'partnership',
    classifications: [
      { value: 'partnership', form: 'f1065', formLabel: 'Form 1065' },
      { value: 's_corp', form: 'f1120s', formLabel: 'Form 1120-S' },
      { value: 'c_corp', form: 'f1120', formLabel: 'Form 1120' },
    ],
  },
  {
    type: 's_corp',
    label: 'S corporation',
    description: '',
    minOwners: 1,
    defaultClassification: 's_corp',
    classifications: [{ value: 's_corp', form: 'f1120s', formLabel: 'Form 1120-S' }],
  },
];

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

let latest: UsEntityValues = DEFAULT_US_VALUES;

function Harness({ initial = DEFAULT_US_VALUES, errors }: Readonly<{ initial?: UsEntityValues; errors?: Parameters<typeof UsEntityCards>[0]['errors'] }>) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <UsEntityCards idPrefix="t" value={value} onChange={setValue} errors={errors} entityTypes={entityTypes} state="TX" />;
}

async function choose(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, option: string | RegExp) {
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('UsEntityCards', () => {
  it('filters the tax classifications by the entity type and shows the return each files', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // No type yet: nothing to choose from.
    expect(screen.getByRole('combobox', { name: 'Entity type' })).toHaveTextContent('Select an entity type');
    expect(screen.getByRole('combobox', { name: 'Tax classification' })).toBeDisabled();

    await choose(user, screen.getByRole('combobox', { name: 'Entity type' }), 'LLC with two or more members');
    expect(latest.entityType).toBe('multi_member_llc');
    // The type's default classification is picked.
    expect(latest.taxClassification).toBe('partnership');
    expect(screen.getByText('Files Form 1065')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Tax classification' }));
    const options = within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Partnership — Form 1065', 'S corporation — Form 1120-S', 'C corporation — Form 1120']);
    await user.click(screen.getByRole('option', { name: 'S corporation — Form 1120-S' }));
    expect(latest.taxClassification).toBe('s_corp');
    expect(screen.getByText('Files Form 1120-S')).toBeInTheDocument();
  });

  it('has a single, fixed classification for a type that cannot elect another', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await choose(user, screen.getByRole('combobox', { name: 'Entity type' }), 'Sole proprietorship');

    expect(latest.taxClassification).toBe('sole_proprietor');
    expect(screen.getByRole('combobox', { name: 'Tax classification' })).toBeDisabled();
    expect(screen.getByText('Files Schedule C (Form 1040)')).toBeInTheDocument();
  });

  it('falls back to the default classification when the new type does not allow the current one', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...DEFAULT_US_VALUES, entityType: 'multi_member_llc', taxClassification: 'c_corp' }} />);

    await choose(user, screen.getByRole('combobox', { name: 'Entity type' }), 'S corporation');
    expect(latest.entityType).toBe('s_corp');
    expect(latest.taxClassification).toBe('s_corp');
  });

  it('formats the EIN as XX-XXXXXXX while typing', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox', { name: 'EIN' }), '123456789');
    expect(latest.ein).toBe('12-3456789');
  });

  it('shows the errors it is given next to the field', () => {
    render(<Harness errors={{ entityType: 'Choose an entity type', ein: 'Enter the EIN as XX-XXXXXXX (9 digits)' }} />);
    expect(screen.getByText('Choose an entity type')).toBeInTheDocument();
    expect(screen.getByText('Enter the EIN as XX-XXXXXXX (9 digits)')).toBeInTheDocument();
  });

  it('switches the fiscal year between a month and a 52–53-week year and previews it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId('fiscal-year-preview')).toHaveTextContent(/Current fiscal year: .* to .*/);
    expect(screen.getByRole('combobox', { name: 'Starts in' })).toBeInTheDocument();

    await choose(user, screen.getByRole('combobox', { name: 'Fiscal year' }), '52–53 weeks');
    expect(latest.fiscalYearKind).toBe('weeks');
    expect(screen.getByRole('combobox', { name: 'Ends in' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Ends on a' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Which one' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Starts in' })).not.toBeInTheDocument();
    expect(screen.getByTestId('fiscal-year-preview')).toHaveTextContent(/\(5[23] weeks\)/);
  });

  it('suggests the time zone of the address state', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Time zone' }));
    expect(await screen.findByRole('option', { name: 'Automatic: Central Time (Chicago)' })).toBeInTheDocument();
  });
});
