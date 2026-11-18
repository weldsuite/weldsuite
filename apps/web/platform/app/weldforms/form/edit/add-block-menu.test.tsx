import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { AddBlockMenu } from './add-block-menu';
import type { BlockKind } from '../../lib/block-types';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

const to = en.weldforms.outline;
const names = en.weldforms.blockTypes;

function setup(props: { layout?: 'classic' | 'conversational'; insideGroup?: boolean } = {}) {
  const onAdd = vi.fn<(kind: BlockKind) => void>();
  render(
    <AddBlockMenu layout={props.layout ?? 'conversational'} insideGroup={props.insideGroup} onAdd={onAdd}>
      <button type="button">open menu</button>
    </AddBlockMenu>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open menu' }));
  return { onAdd };
}

describe('AddBlockMenu', () => {
  it('lists the question types by category once opened', () => {
    setup();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(to.addBlock)).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.weldforms.blockCategories.choice })).toBeTruthy();
    expect(screen.getByRole('button', { name: names.short_text })).toBeTruthy();
    expect(screen.getByRole('button', { name: names.group })).toBeTruthy();
  });

  it('hides page break outside the classic layout and inside groups', () => {
    setup();
    expect(screen.queryByRole('button', { name: names.page_break })).toBeNull();
  });

  it('offers page break in the classic layout', () => {
    setup({ layout: 'classic' });
    expect(screen.getByRole('button', { name: names.page_break })).toBeTruthy();
  });

  it('inside a group offers neither groups nor page breaks and titles the dialog accordingly', () => {
    setup({ layout: 'classic', insideGroup: true });
    expect(screen.getByText(to.addToGroup)).toBeTruthy();
    expect(screen.queryByRole('button', { name: names.group })).toBeNull();
    expect(screen.queryByRole('button', { name: names.page_break })).toBeNull();
    expect(screen.getByRole('button', { name: names.statement })).toBeTruthy();
  });

  it('adds the clicked type and closes', () => {
    const { onAdd } = setup();
    fireEvent.click(screen.getByRole('button', { name: names.email }));
    expect(onAdd).toHaveBeenCalledWith('email');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters by type name', () => {
    setup();
    fireEvent.change(screen.getByRole('textbox', { name: to.searchBlocks }), { target: { value: 'phone' } });
    expect(screen.getByRole('button', { name: names.phone })).toBeTruthy();
    expect(screen.queryByRole('button', { name: names.email })).toBeNull();
  });

  it('lists the whole category when the query matches its name', () => {
    setup();
    fireEvent.change(screen.getByRole('textbox', { name: to.searchBlocks }), { target: { value: 'files' } });
    expect(screen.getByRole('button', { name: names.file_upload })).toBeTruthy();
    expect(screen.getByRole('button', { name: names.signature })).toBeTruthy();
    expect(screen.queryByRole('button', { name: names.short_text })).toBeNull();
  });

  it('adds the first match on Enter', () => {
    const { onAdd } = setup();
    const search = screen.getByRole('textbox', { name: to.searchBlocks });
    fireEvent.change(search, { target: { value: 'phone' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('phone');
  });

  it('ignores Enter on an empty query and other keys', () => {
    const { onAdd } = setup();
    const search = screen.getByRole('textbox', { name: to.searchBlocks });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.change(search, { target: { value: 'phone' } });
    fireEvent.keyDown(search, { key: 'a' });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('shows an empty line when nothing matches, and Enter adds nothing', () => {
    const { onAdd } = setup();
    const search = screen.getByRole('textbox', { name: to.searchBlocks });
    fireEvent.change(search, { target: { value: ' zzz ' } });
    expect(screen.getByText(to.noBlockTypes.replace('{query}', 'zzz'))).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('resets the query when the dialog closes', () => {
    setup();
    fireEvent.change(screen.getByRole('textbox', { name: to.searchBlocks }), { target: { value: 'phone' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'open menu' }));
    expect((screen.getByRole('textbox', { name: to.searchBlocks }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: names.email })).toBeTruthy();
  });
});
