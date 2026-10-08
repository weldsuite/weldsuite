import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CsvFormatEditor } from './csv-format-editor';
import { draftFromFormat, formatFromDraft, readCsvTable, type CsvFormatDraft } from './csv-format-model';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';
import type { CsvFormat } from '@/lib/api/domains/weldbooks-banking';

const FILE = [
  'Date,Description,Debit,Credit,Check #,Memo',
  '01/05/2026,Coffee,4.50,,,',
  '01/06/2026,Refund,,10.00,,',
].join('\n');

const PROPOSAL: CsvFormat = {
  dateFormat: 'MDY',
  decimalSeparator: '.',
  thousandsSeparator: ',',
  negativeStyle: 'minus',
  columns: { date: 'Date', description: 'Description', amount: 'Debit' },
  hasHeader: true,
  skipRows: 0,
  delimiter: ',',
};

/** The editor under a parent that holds the draft and reports the request it would send. */
function Harness({
  onFormat,
  ambiguous = false,
  onConfirmed,
}: Readonly<{ onFormat: (format: CsvFormat | null) => void; ambiguous?: boolean; onConfirmed?: (confirmed: boolean) => void }>) {
  const initialTable = readCsvTable(FILE, { delimiter: ',', skipRows: 0, hasHeader: true });
  const [draft, setDraft] = useState<CsvFormatDraft>(() => draftFromFormat(PROPOSAL, initialTable.headers));
  const [confirmed, setConfirmed] = useState(!ambiguous);
  const [remember, setRemember] = useState(true);
  const table = readCsvTable(FILE, draft);
  onFormat(formatFromDraft(draft, table.headers));
  return (
    <CsvFormatEditor
      draft={draft}
      onDraftChange={setDraft}
      table={table}
      dateOrderAmbiguous={ambiguous}
      dateOrderConfirmed={confirmed}
      onDateOrderConfirmedChange={(value) => {
        setConfirmed(value);
        onConfirmed?.(value);
      }}
      warnings={ambiguous ? ['Every date could be month-first or day-first; confirm the order'] : []}
      remember={remember}
      onRememberChange={setRemember}
    />
  );
}

async function choose(trigger: HTMLElement, optionName: string | RegExp) {
  const user = userEvent.setup();
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: optionName }));
}

describe('CsvFormatEditor', () => {
  beforeAll(polyfillRadixSelect);

  it('shows the file split into columns and the proposed mapping', () => {
    const onFormat = vi.fn();
    renderWithProviders(<Harness onFormat={onFormat} />);
    const sample = screen.getByText('The file, as it is split into columns').parentElement as HTMLElement;
    expect(within(sample).getByText('Check #')).toBeInTheDocument();
    expect(within(sample).getByText('Coffee')).toBeInTheDocument();
    expect(onFormat).toHaveBeenLastCalledWith(expect.objectContaining({ columns: { date: 'Date', description: 'Description', amount: 'Debit' } }));
  });

  it('turns mapping edits into the request payload', async () => {
    const onFormat = vi.fn();
    renderWithProviders(<Harness onFormat={onFormat} />);

    await choose(screen.getByTestId('csv-column-amount'), /3\. Debit/);
    await choose(screen.getByTestId('csv-column-checkNumber'), /5\. Check #/);
    await choose(screen.getByTestId('csv-date-order'), /Day \/ month \/ year/);
    await choose(screen.getByTestId('csv-negative-style'), 'Parentheses ((123.45))');

    expect(onFormat).toHaveBeenLastCalledWith({
      dateFormat: 'DMY',
      decimalSeparator: '.',
      thousandsSeparator: ',',
      negativeStyle: 'parentheses',
      columns: { date: 'Date', description: 'Description', amount: 'Debit', checkNumber: 'Check #' },
      hasHeader: true,
      skipRows: 0,
      delimiter: ',',
    });
  });

  it('swaps the amount column for debit and credit columns', async () => {
    const onFormat = vi.fn();
    renderWithProviders(<Harness onFormat={onFormat} />);

    await choose(screen.getByTestId('csv-negative-style'), 'Separate debit and credit columns');
    expect(screen.queryByTestId('csv-column-amount')).not.toBeInTheDocument();
    // Nothing mapped yet: the layout is incomplete and no request is built.
    expect(onFormat).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('csv-problems')).toHaveTextContent('Pick a debit column, a credit column, or both.');

    await choose(screen.getByTestId('csv-column-debit'), /3\. Debit/);
    await choose(screen.getByTestId('csv-column-credit'), /4\. Credit/);
    expect(onFormat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        negativeStyle: 'debit_credit_columns',
        columns: { date: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit' },
      }),
    );
  });

  it('re-reads the columns when the file has no header row', async () => {
    const onFormat = vi.fn();
    renderWithProviders(<Harness onFormat={onFormat} />);
    await userEvent.setup().click(screen.getByTestId('csv-has-header'));

    // Column names are now positions, and so are the references sent.
    expect(screen.getAllByText('Column 1').length).toBeGreaterThan(0);
    await choose(screen.getByTestId('csv-column-date'), /1\. Column 1/);
    await choose(screen.getByTestId('csv-column-description'), /2\. Column 2/);
    await choose(screen.getByTestId('csv-column-amount'), /3\. Column 3/);
    expect(onFormat).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasHeader: false, columns: { date: 0, description: 1, amount: 2 } }),
    );
  });

  it('asks for the date order to be confirmed when the file is ambiguous', async () => {
    const onConfirmed = vi.fn();
    renderWithProviders(<Harness onFormat={vi.fn()} ambiguous onConfirmed={onConfirmed} />);

    expect(screen.getByText('Check the date order')).toBeInTheDocument();
    expect(screen.getByText('Every date could be month-first or day-first. Confirm the order below.')).toBeInTheDocument();
    const confirm = screen.getByTestId('csv-confirm-date-order');
    expect(confirm).not.toBeChecked();
    await userEvent.setup().click(confirm);
    expect(onConfirmed).toHaveBeenCalledWith(true);
  });

  it('does not show the date warning when the order is clear', () => {
    renderWithProviders(<Harness onFormat={vi.fn()} />);
    expect(screen.queryByText('Check the date order')).not.toBeInTheDocument();
  });
});
