import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';

vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ label, type, id }: { label: string; type: string; id: string }) => <a href={`#${type}:${id}`}>{label}</a>,
}));

import { TimesheetEntryRow, entryLockReason, type EntryRowData } from './invoiced-entry';

const copy = en.weldbooksContactPage.flow;
const approvedText = en.sweep.weldflow.timesheetPage.entryApprovedLocked;

const entry = (extra: Partial<EntryRowData> = {}): EntryRowData => ({
  id: 'te_1',
  duration: 150,
  billable: true,
  status: 'draft',
  description: 'Site visit',
  userName: 'Eva',
  invoiceId: null,
  ...extra,
});

function renderRow(row: EntryRowData, deleting = false) {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <I18nProvider initialLanguage="en">
      <TimesheetEntryRow entry={row} deleting={deleting} onEdit={onEdit} onDelete={onDelete} />
    </I18nProvider>,
  );
  return { onEdit, onDelete };
}

describe('why an entry is locked', () => {
  const texts = { invoiced: 'on an invoice', approved: 'approved' };

  it('is not locked while it is neither invoiced nor approved', () => {
    expect(entryLockReason({ invoiceId: null, status: 'draft' }, texts)).toBeNull();
    expect(entryLockReason({}, texts)).toBeNull();
  });

  it('says invoiced before approved, since the invoice is what releases it', () => {
    expect(entryLockReason({ invoiceId: 'inv_1', status: 'approved' }, texts)).toBe('on an invoice');
    expect(entryLockReason({ invoiceId: null, status: 'approved' }, texts)).toBe('approved');
  });
});

describe('an entry in a timesheet cell', () => {
  it('can be edited and deleted while it is not invoiced', async () => {
    const user = userEvent.setup();
    const { onEdit, onDelete } = renderRow(entry());
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(copy.invoicedChip)).not.toBeInTheDocument();
  });

  it('shows an Invoiced chip that opens the invoice', () => {
    renderRow(entry({ invoiceId: 'inv_7' }));
    expect(screen.getByRole('link', { name: copy.invoicedChip })).toHaveAttribute('href', '#invoice:inv_7');
  });

  it('keeps edit and delete reachable but inert when it is invoiced, and says why', () => {
    const { onEdit, onDelete } = renderRow(entry({ invoiceId: 'inv_7' }));
    const edit = screen.getByRole('button', { name: /Edit/ });
    const remove = screen.getByRole('button', { name: /Delete/ });
    for (const button of [edit, remove]) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      // Not natively disabled: the person can land on it and learn why.
      expect(button).not.toBeDisabled();
      expect(button).toHaveTextContent(copy.invoicedTip);
      fireEvent.click(button);
    }
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('is locked for an approved entry too, with that reason', () => {
    const { onEdit } = renderRow(entry({ status: 'approved' }));
    const edit = screen.getByRole('button', { name: /Edit/ });
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    expect(edit).toHaveTextContent(approvedText);
    fireEvent.click(edit);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('says which of the two reasons holds when an entry is both approved and invoiced: the invoice', () => {
    renderRow(entry({ status: 'approved', invoiceId: 'inv_7' }));
    const edit = screen.getByRole('button', { name: /Edit/ });
    expect(edit).toHaveTextContent(copy.invoicedTip);
    expect(edit).not.toHaveTextContent(approvedText);
  });

  it('disables delete natively while the delete request runs', () => {
    renderRow(entry(), true);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});
