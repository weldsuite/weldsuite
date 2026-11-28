import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import type { ColumnDef } from '@/components/entity-list';
import { WeldbooksEntityList } from './weldbooks-entity-list';

interface Row {
  id: string;
  name: string;
  locked?: boolean;
}

const COLUMNS: ColumnDef<Row>[] = [{ id: 'name', header: 'Name', width: 'flex-1', render: (row) => <span>{row.name}</span> }];
const ROWS: Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Gamma', locked: true },
];

function Harness({ onAction = vi.fn() }: Readonly<{ onAction?: (ids: string[]) => void }>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <WeldbooksEntityList<Row>
      items={ROWS}
      isLoading={false}
      columns={COLUMNS}
      getRowLabel={(row) => row.name}
      emptyState={{ title: 'Nothing', description: 'Empty' }}
      selection={{
        selectedIds: selected,
        isSelectable: (row) => !row.locked,
        onToggle: (id) =>
          setSelected((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
          }),
        onToggleAll: (checked) => setSelected(checked ? new Set(ROWS.filter((row) => !row.locked).map((row) => row.id)) : new Set()),
        actions: (
          <button type="button" onClick={() => onAction([...selected])}>
            Do it
          </button>
        ),
      }}
    />
  );
}

describe('WeldbooksEntityList selection', () => {
  it('puts a named checkbox on each selectable row and none on a row that cannot be selected', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select Gamma' })).not.toBeInTheDocument();
  });

  it('says how many are selected in a status message and shows the bulk actions only then', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderWithProviders(<Harness onAction={onAction} />);
    expect(screen.queryByRole('button', { name: 'Do it' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    const bar = screen.getByTestId('selection-bar');
    expect(within(bar).getByRole('status')).toHaveTextContent('1 selected');
    await user.click(within(bar).getByRole('button', { name: 'Do it' }));
    expect(onAction).toHaveBeenCalledWith(['a']);
  });

  it('selects every selectable row at once and clears again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Beta' })).toBeChecked();
    expect(within(screen.getByTestId('selection-bar')).getByRole('status')).toHaveTextContent('2 selected');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).not.toBeChecked();
  });

  it('does not open a row when its checkbox is clicked', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderWithProviders(
      <WeldbooksEntityList<Row>
        items={ROWS}
        isLoading={false}
        columns={COLUMNS}
        getRowLabel={(row) => row.name}
        onRowClick={onRowClick}
        emptyState={{ title: 'Nothing', description: 'Empty' }}
        selection={{ selectedIds: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn() }}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('WeldbooksEntityList create menu', () => {
  it('is one button without more to create, and a menu with them', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onMore = vi.fn();
    const { unmount } = renderWithProviders(
      <WeldbooksEntityList<Row> items={ROWS} isLoading={false} columns={COLUMNS} emptyState={{ title: 'Nothing', description: 'Empty' }} createButton={{ label: 'New invoice', onClick: onCreate }} />,
    );
    await user.click(screen.getByRole('button', { name: 'New invoice' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    unmount();

    renderWithProviders(
      <WeldbooksEntityList<Row>
        items={ROWS}
        isLoading={false}
        columns={COLUMNS}
        emptyState={{ title: 'Nothing', description: 'Empty' }}
        createButton={{ label: 'New invoice', onClick: onCreate, more: [{ label: 'New credit note', onClick: onMore }] }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'New invoice' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole('menuitem', { name: 'New credit note' }));
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
