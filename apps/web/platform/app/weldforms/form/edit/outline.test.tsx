import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { en } from '@weldsuite/i18n/locales/en';
import { createBlankDefinition, createField, createGroup, createPageBreak, createStatement, type FormDefinition } from '@weldsuite/forms-engine';
import type { FormEditor, Selection } from '../editor-context';
import { Outline } from './outline';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

let dragEnd: ((event: DragEndEvent) => void) | undefined;
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ onDragEnd, children, ...rest }: React.ComponentProps<typeof actual.DndContext>) => {
      dragEnd = onDragEnd;
      return <actual.DndContext {...rest} onDragEnd={onDragEnd}>{children as ReactNode}</actual.DndContext>;
    },
  };
});

let editor: FormEditor;
vi.mock('../editor-context', () => ({
  useFormEditor: () => editor,
}));

const to = en.weldforms.outline;
const names = en.weldforms.blockTypes;

const name = createField('short_text', { title: 'Your name', ref: 'name' });
const mail = createField('email', { title: 'Mail', ref: 'mail' });
const group = { ...createGroup({ title: 'Contact', ref: 'contact' }), children: [mail] };
const note = createStatement({ title: '', ref: 'note' });
const pageBreak = createPageBreak({ ref: 'page_a' });

function fakeEditor(definition: FormDefinition, over: Partial<FormEditor> = {}): FormEditor {
  const fake = {
    definition,
    selection: null as Selection,
    canEdit: true,
    issuesByBlock: new Map(),
    select: vi.fn((next: Selection) => {
      fake.selection = next;
    }),
    editDefinition: vi.fn((recipe: (d: FormDefinition) => FormDefinition) => {
      fake.definition = recipe(fake.definition);
    }),
    ...over,
  };
  return fake as unknown as FormEditor;
}

function withBlocks(blocks: FormDefinition['blocks'], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { ...createBlankDefinition(), blocks, ...extra };
}

function openRowMenu(index: number) {
  const trigger = screen.getAllByRole('button', { name: en.common.actions.openMenu })[index]!;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

describe('Outline', () => {
  const onDataClick = vi.fn();

  beforeEach(() => {
    onDataClick.mockClear();
    dragEnd = undefined;
    editor = fakeEditor(withBlocks([name, group, note, pageBreak]));
  });

  it('renders sections, numbered questions, group children and untitled labels', () => {
    render(<Outline onDataClick={onDataClick} />);
    expect(screen.getByRole('heading', { name: to.welcome })).toBeTruthy();
    expect(screen.getByRole('heading', { name: to.questions })).toBeTruthy();
    expect(screen.getByRole('heading', { name: to.endings })).toBeTruthy();
    expect(screen.getByText('Your name')).toBeTruthy();
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('Mail')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByText(to.untitled)).toBeTruthy();
    expect(screen.getByText(names.page_break)).toBeTruthy();
    expect(screen.getByText('Thank you!')).toBeTruthy();
  });

  it('selects a block, a group child, an ending and the welcome screen', () => {
    editor = fakeEditor(withBlocks([name, group], { welcome: { title: 'Hello there' } }));
    render(<Outline onDataClick={onDataClick} />);
    fireEvent.click(screen.getByText('Your name'));
    expect(editor.select).toHaveBeenLastCalledWith({ kind: 'block', id: name.id });
    fireEvent.click(screen.getByText('Mail'));
    expect(editor.select).toHaveBeenLastCalledWith({ kind: 'block', id: mail.id });
    fireEvent.click(screen.getByText('Thank you!'));
    expect(editor.select).toHaveBeenLastCalledWith({ kind: 'ending', id: editor.definition.endings[0]!.id });
    fireEvent.click(screen.getByText('Hello there'));
    expect(editor.select).toHaveBeenLastCalledWith({ kind: 'welcome' });
  });

  it('marks the selected row and shows the issue count', () => {
    editor = fakeEditor(withBlocks([name]), {
      selection: { kind: 'block', id: name.id },
      issuesByBlock: new Map([[name.id, [{ code: 'x' }, { code: 'y' }]]]) as unknown as FormEditor['issuesByBlock'],
    });
    render(<Outline onDataClick={onDataClick} />);
    expect(screen.getByText('Your name').closest('button')?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('img', { name: to.issues.replace('{count}', '2') })).toBeTruthy();
  });

  it('opens the hidden fields dialog callback', () => {
    render(<Outline onDataClick={onDataClick} />);
    fireEvent.click(screen.getByRole('button', { name: to.hiddenAndVariables }));
    expect(onDataClick).toHaveBeenCalled();
  });

  it('adds a welcome screen from the header + and selects it', () => {
    render(<Outline onDataClick={onDataClick} />);
    fireEvent.click(screen.getAllByRole('button', { name: to.addWelcome })[0]!);
    expect(editor.definition.welcome).toEqual({ title: to.welcomeDefaultTitle });
    expect(editor.select).toHaveBeenCalledWith({ kind: 'welcome' });
  });

  it('adds a welcome screen from the dashed row', () => {
    render(<Outline onDataClick={onDataClick} />);
    const buttons = screen.getAllByRole('button', { name: to.addWelcome });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(editor.definition.welcome).not.toBeNull();
  });

  it('disables the welcome + once there is a welcome screen', () => {
    editor = fakeEditor(withBlocks([name], { welcome: { title: 'Hi' } }));
    render(<Outline onDataClick={onDataClick} />);
    expect((screen.getByRole('button', { name: to.addWelcome }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds an ending and selects it', () => {
    render(<Outline onDataClick={onDataClick} />);
    fireEvent.click(screen.getAllByRole('button', { name: to.addEnding })[0]!);
    expect(editor.definition.endings).toHaveLength(2);
    expect(editor.select).toHaveBeenCalledWith({ kind: 'ending', id: editor.definition.endings[1]!.id });
  });

  it('shows the dashed add-ending row when no endings remain', () => {
    editor = fakeEditor(withBlocks([name], { endings: [] }));
    render(<Outline onDataClick={onDataClick} />);
    const buttons = screen.getAllByRole('button', { name: to.addEnding });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(editor.definition.endings).toHaveLength(1);
  });

  it('adds a question after the selected block from the add dialog', () => {
    editor = fakeEditor(withBlocks([name, note]), { selection: { kind: 'block', id: name.id } });
    render(<Outline onDataClick={onDataClick} />);
    fireEvent.click(screen.getByRole('button', { name: to.addBlock }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: names.email }));
    expect(editor.definition.blocks.map((b) => b.type)).toEqual(['short_text', 'email', 'statement']);
    expect(editor.select).toHaveBeenCalledWith({ kind: 'block', id: editor.definition.blocks[1]!.id });
  });

  it('adds every kind of block', () => {
    editor = fakeEditor(withBlocks([], { presentation: { ...createBlankDefinition().presentation, layout: 'classic' } }));
    const kinds = [names.statement, names.group, names.page_break, names.short_text];
    for (const label of kinds) {
      const { unmount } = render(<Outline onDataClick={onDataClick} />);
      fireEvent.click(screen.getAllByRole('button', { name: to.addBlock })[0]!);
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: label }));
      unmount();
    }
    expect(editor.definition.blocks.map((b) => b.type)).toEqual(['statement', 'group', 'page_break', 'short_text']);
  });

  it('shows the dashed add row for an empty form and adds from it', () => {
    editor = fakeEditor(withBlocks([]));
    render(<Outline onDataClick={onDataClick} />);
    const rows = screen.getAllByRole('button', { name: to.addBlock });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: names.short_text }));
    expect(editor.definition.blocks).toHaveLength(1);
  });

  it('adds into an empty group', () => {
    const empty = createGroup({ title: 'Empty', ref: 'empty' });
    editor = fakeEditor(withBlocks([empty]));
    render(<Outline onDataClick={onDataClick} />);
    fireEvent.click(screen.getByRole('button', { name: to.addToGroup }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: names.short_text }));
    const g = editor.definition.blocks[0];
    expect(g?.type === 'group' && g.children).toHaveLength(1);
  });

  it('shows the group add row for a selected group with children', () => {
    editor = fakeEditor(withBlocks([group]), { selection: { kind: 'block', id: group.id } });
    render(<Outline onDataClick={onDataClick} />);
    expect(screen.getByRole('button', { name: to.addToGroup })).toBeTruthy();
  });

  it('is read-only without edit rights: no menus, add buttons or drag handles', () => {
    editor = fakeEditor(withBlocks([]), { canEdit: false });
    render(<Outline onDataClick={onDataClick} />);
    expect(screen.getByText(to.empty)).toBeTruthy();
    expect(screen.queryByRole('button', { name: to.addBlock })).toBeNull();
    expect(screen.queryByRole('button', { name: to.addWelcome })).toBeNull();
    expect(screen.queryByRole('button', { name: to.addEnding })).toBeNull();

    editor = fakeEditor(withBlocks([name]), { canEdit: false });
    render(<Outline onDataClick={onDataClick} />);
    expect(screen.queryByRole('button', { name: en.common.actions.openMenu })).toBeNull();
    expect(screen.queryByRole('button', { name: to.drag })).toBeNull();
  });

  describe('row menu', () => {
    it('disables move up on the first row and move down on the last', () => {
      editor = fakeEditor(withBlocks([name, note]));
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      expect(screen.getByRole('menuitem', { name: to.moveUp }).getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByRole('menuitem', { name: to.moveDown }).getAttribute('aria-disabled')).toBeNull();
    });

    it('moves a block down', () => {
      editor = fakeEditor(withBlocks([name, note]));
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      fireEvent.click(screen.getByRole('menuitem', { name: to.moveDown }));
      expect(editor.definition.blocks.map((b) => b.id)).toEqual([note.id, name.id]);
    });

    it('moves a block up', () => {
      editor = fakeEditor(withBlocks([name, note]));
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(1);
      fireEvent.click(screen.getByRole('menuitem', { name: to.moveUp }));
      expect(editor.definition.blocks.map((b) => b.id)).toEqual([note.id, name.id]);
    });

    it('duplicates a block', () => {
      editor = fakeEditor(withBlocks([name]));
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      fireEvent.click(screen.getByRole('menuitem', { name: to.duplicate }));
      expect(editor.definition.blocks).toHaveLength(2);
    });

    it('offers no duplicate for a page break', () => {
      editor = fakeEditor(withBlocks([pageBreak]));
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      expect(screen.queryByRole('menuitem', { name: to.duplicate })).toBeNull();
    });

    it('removes a block and leaves the selection alone when another row was selected', () => {
      editor = fakeEditor(withBlocks([name, note]), { selection: { kind: 'block', id: note.id } });
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      expect(editor.definition.blocks.map((b) => b.id)).toEqual([note.id]);
      expect(editor.select).not.toHaveBeenCalled();
    });

    it('selects a neighbour when the selected block is removed', () => {
      editor = fakeEditor(withBlocks([name, note]), { selection: { kind: 'block', id: name.id } });
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      expect(editor.select).toHaveBeenCalledWith({ kind: 'block', id: note.id });
    });

    it('clears the selection when the only block is removed', () => {
      editor = fakeEditor(withBlocks([name]), { selection: { kind: 'block', id: name.id } });
      render(<Outline onDataClick={onDataClick} />);
      openRowMenu(0);
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      expect(editor.select).toHaveBeenCalledWith(null);
    });
  });

  describe('drag and drop', () => {
    function end(active: string, over: string | null): DragEndEvent {
      return { active: { id: active }, over: over ? { id: over } : null } as unknown as DragEndEvent;
    }

    it('moves a block to where another was dropped', () => {
      editor = fakeEditor(withBlocks([name, note]));
      render(<Outline onDataClick={onDataClick} />);
      dragEnd?.(end(name.id, note.id));
      expect(editor.definition.blocks.map((b) => b.id)).toEqual([note.id, name.id]);
    });

    it('ignores a drop on nothing, on itself, or on an unknown block', () => {
      render(<Outline onDataClick={onDataClick} />);
      dragEnd?.(end(name.id, null));
      dragEnd?.(end(name.id, name.id));
      dragEnd?.(end(name.id, 'nope'));
      expect(editor.editDefinition).not.toHaveBeenCalled();
    });
  });
});
