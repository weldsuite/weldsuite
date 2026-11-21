import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { createBlankDefinition, createEnding, createField, createGroup, createPageBreak, createStatement, type BlockLogic, type FormDefinition } from '@weldsuite/forms-engine';
import type { FormEditor, Selection } from '../editor-context';
import { PropertiesPanel } from './properties-panel';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

let editor: FormEditor;
vi.mock('../editor-context', () => ({
  useFormEditor: () => editor,
}));

vi.mock('../../components/media-fields', () => ({
  MediaField: () => <div>media field</div>,
}));
vi.mock('./field-properties', () => ({
  FieldProperties: ({ field }: { field: { type: string } }) => <div>field properties {field.type}</div>,
}));

const tp = en.weldforms.properties;
const to = en.weldforms.outline;

const first = createField('short_text', { title: 'Your name', ref: 'your_name' });
const second = createField('email', { title: 'Mail', ref: 'mail' });
const group = { ...createGroup({ title: 'Contact', ref: 'contact' }), children: [createField('phone', { title: 'Phone', ref: 'phone_nr' })] };
const note = createStatement({ title: 'Read this', ref: 'note' });
const pageBreak = createPageBreak({ ref: 'page_a', title: 'Page one' });

function fakeEditor(over: { definition?: FormDefinition; selection?: Selection; canEdit?: boolean; status?: string } = {}): FormEditor {
  const fake = {
    definition: over.definition ?? { ...createBlankDefinition(), blocks: [first, second, group, note, pageBreak] },
    selection: over.selection ?? null,
    canEdit: over.canEdit ?? true,
    form: { id: 'frm_1', status: over.status ?? 'draft' },
    select: vi.fn(),
    editDefinition: vi.fn((recipe: (d: FormDefinition) => FormDefinition) => {
      fake.definition = recipe(fake.definition);
    }),
  };
  return fake as unknown as FormEditor;
}

type Block = FormDefinition['blocks'][number];

/** A block's description; page breaks have none. */
function descriptionOf(block: Block | undefined): string | undefined {
  if (!block || block.type === 'page_break') throw new Error('expected a block with a description');
  return block.description;
}

/** A statement's button text. */
function buttonTextOf(block: Block | undefined): string | undefined {
  if (block?.type !== 'statement') throw new Error('expected a statement');
  return block.properties.buttonText;
}

function openMenu(label: string) {
  const trigger = screen.getByRole('button', { name: `${en.common.actions.openMenu}: ${label}` });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

describe('PropertiesPanel', () => {
  beforeEach(() => {
    navigate.mockClear();
    editor = fakeEditor();
  });

  it('asks to select something when nothing is selected', () => {
    render(<PropertiesPanel />);
    expect(screen.getByRole('heading', { name: en.weldforms.editor.paneProperties })).toBeTruthy();
    expect(screen.getByText(tp.nothingSelected)).toBeTruthy();
  });

  it('renders nothing for a selection that no longer exists', () => {
    editor = fakeEditor({ selection: { kind: 'block', id: 'gone' } });
    const { container } = render(<PropertiesPanel />);
    expect(container.textContent).toBe('');
    editor = fakeEditor({ selection: { kind: 'ending', id: 'gone' } });
    const again = render(<PropertiesPanel />);
    expect(again.container.textContent).toBe('');
  });

  describe('a question', () => {
    beforeEach(() => {
      editor = fakeEditor({ selection: { kind: 'block', id: first.id } });
    });

    it('shows its title, section name, field properties and logic', () => {
      render(<PropertiesPanel />);
      expect(screen.getByRole('heading', { name: tp.question })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: tp.title }) as HTMLTextAreaElement).value).toBe('Your name');
      expect(screen.getByText('field properties short_text')).toBeTruthy();
      expect(screen.getByText(tp.noLogic)).toBeTruthy();
      expect(screen.getByText(tp.required)).toBeTruthy();
      expect(screen.getByText(tp.sensitive)).toBeTruthy();
    });

    it('edits the title and keeps an auto-made ref in step', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, definition: { ...createBlankDefinition(), blocks: [first] } });
      render(<PropertiesPanel />);
      fireEvent.change(screen.getByRole('textbox', { name: tp.title }), { target: { value: 'Full name' } });
      const next = editor.definition.blocks[0];
      expect(next?.title).toBe('Full name');
      expect(next?.ref).toBe('full_name');
    });

    it('keeps a hand-made ref when the title changes', () => {
      const custom = { ...first, ref: 'custom_ref' };
      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, definition: { ...createBlankDefinition(), blocks: [custom] } });
      render(<PropertiesPanel />);
      fireEvent.change(screen.getByRole('textbox', { name: tp.title }), { target: { value: 'Other' } });
      expect(editor.definition.blocks[0]?.ref).toBe('custom_ref');
    });

    it('keeps the ref once the form is published', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, definition: { ...createBlankDefinition(), blocks: [{ ...first, ref: 'your_name' }] }, status: 'published' });
      render(<PropertiesPanel />);
      expect(screen.getByText(tp.refPublishedHelp)).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox', { name: tp.title }), { target: { value: 'Renamed' } });
      expect(editor.definition.blocks[0]?.ref).toBe('your_name');
    });

    it('edits the description, and clears it when emptied', () => {
      const view = render(<PropertiesPanel />);
      fireEvent.change(screen.getByRole('textbox', { name: tp.description }), { target: { value: 'Say it' } });
      expect(descriptionOf(editor.definition.blocks[0])).toBe('Say it');
      view.unmount();

      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, definition: { ...createBlankDefinition(), blocks: [{ ...first, description: 'Old' }] } });
      render(<PropertiesPanel />);
      fireEvent.change(screen.getByRole('textbox', { name: tp.description }), { target: { value: '' } });
      expect(descriptionOf(editor.definition.blocks[0])).toBeUndefined();
    });

    it('toggles required and sensitive', () => {
      render(<PropertiesPanel />);
      fireEvent.click(screen.getByRole('switch', { name: tp.required }));
      fireEvent.click(screen.getByRole('switch', { name: tp.sensitive }));
      const block = editor.definition.blocks[0];
      expect(block && 'required' in block && block.required).toBe(true);
      expect(block && 'sensitive' in block && block.sensitive).toBe(true);
    });

    it('edits the reference when it is valid and unique, and flags bad ones', () => {
      render(<PropertiesPanel />);
      const ref = screen.getByDisplayValue('your_name');
      fireEvent.focus(ref);
      fireEvent.change(ref, { target: { value: 'Bad Ref' } });
      expect(screen.getByText(tp.refInvalid)).toBeTruthy();
      expect(editor.definition.blocks[0]?.ref).toBe('your_name');
      fireEvent.change(ref, { target: { value: 'mail' } });
      expect(screen.getByText(tp.refTaken)).toBeTruthy();
      fireEvent.change(ref, { target: { value: 'full_name' } });
      expect(editor.definition.blocks[0]?.ref).toBe('full_name');
      fireEvent.blur(ref);
    });

    it('counts the rules on the question', () => {
      const logic = [{ blockId: first.id, calculations: [], jumps: [{}, {}], otherwise: {} }] as unknown as BlockLogic[];
      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, definition: { ...createBlankDefinition(), blocks: [first, second], logic } });
      render(<PropertiesPanel />);
      expect(screen.getByText(tp.logicCount.replace('{count}', '3'))).toBeTruthy();
    });

    it('opens the Logic tab on this question with Edit logic', () => {
      render(<PropertiesPanel />);
      fireEvent.click(screen.getByRole('button', { name: tp.editLogic }));
      expect(editor.select).toHaveBeenCalledWith({ kind: 'block', id: first.id });
      expect(navigate).toHaveBeenCalledWith({ to: '/weldforms/$formId/logic', params: { formId: 'frm_1' }, search: { block: first.id } });
    });

    it('points Edit logic at the group for a question inside one', () => {
      const child = group.children[0]!;
      editor = fakeEditor({ selection: { kind: 'block', id: child.id } });
      render(<PropertiesPanel />);
      fireEvent.click(screen.getByRole('button', { name: tp.editLogic }));
      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { block: group.id } }));
    });

    it('moves the block down from the header menu, and disables moving up on the first', () => {
      render(<PropertiesPanel />);
      openMenu(tp.question);
      expect(screen.getByRole('menuitem', { name: to.moveUp }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(screen.getByRole('menuitem', { name: to.moveDown }));
      expect(editor.definition.blocks.slice(0, 2).map((b) => b.id)).toEqual([second.id, first.id]);
    });

    it('moves a block up, duplicates and removes it from the menu', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: second.id } });
      const view = render(<PropertiesPanel />);
      openMenu(tp.question);
      fireEvent.click(screen.getByRole('menuitem', { name: to.moveUp }));
      expect(editor.definition.blocks.slice(0, 2).map((b) => b.id)).toEqual([second.id, first.id]);
      view.unmount();

      editor = fakeEditor({ selection: { kind: 'block', id: second.id } });
      const dup = render(<PropertiesPanel />);
      openMenu(tp.question);
      fireEvent.click(screen.getByRole('menuitem', { name: to.duplicate }));
      expect(editor.definition.blocks).toHaveLength(6);
      dup.unmount();

      editor = fakeEditor({ selection: { kind: 'block', id: second.id } });
      render(<PropertiesPanel />);
      openMenu(tp.question);
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      expect(editor.definition.blocks.some((b) => b.id === second.id)).toBe(false);
      expect(editor.select).toHaveBeenCalledWith({ kind: 'block', id: expect.any(String) });
    });

    it('clears the selection when the last block is removed', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, definition: { ...createBlankDefinition(), blocks: [first] } });
      render(<PropertiesPanel />);
      openMenu(tp.question);
      expect(screen.getByRole('menuitem', { name: to.moveDown }).getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(screen.getByRole('menuitem', { name: en.common.actions.delete }));
      expect(editor.select).toHaveBeenCalledWith(null);
    });

    it('is read-only without edit rights: no menu and disabled fields', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: first.id }, canEdit: false });
      render(<PropertiesPanel />);
      expect(screen.queryByRole('button', { name: `${en.common.actions.openMenu}: ${tp.question}` })).toBeNull();
      expect((screen.getByRole('textbox', { name: tp.title }) as HTMLTextAreaElement).disabled).toBe(true);
    });
  });

  describe('a nested question', () => {
    it('moves within its group', () => {
      const child = group.children[0]!;
      editor = fakeEditor({ selection: { kind: 'block', id: child.id } });
      render(<PropertiesPanel />);
      openMenu(tp.question);
      expect(screen.getByRole('menuitem', { name: to.moveUp }).getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByRole('menuitem', { name: to.moveDown }).getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('a statement and a group', () => {
    it('edits the statement button text', () => {
      const withButton = { ...note, properties: { ...note.properties, buttonText: 'Old' } };
      editor = fakeEditor({ selection: { kind: 'block', id: note.id }, definition: { ...createBlankDefinition(), blocks: [withButton] } });
      render(<PropertiesPanel />);
      expect(screen.getByRole('heading', { name: tp.statement })).toBeTruthy();
      expect(screen.queryByText(tp.required)).toBeNull();
      const [button] = screen.getAllByRole('textbox').filter((el) => el.tagName === 'INPUT' && (el as HTMLInputElement).maxLength === 60);
      fireEvent.change(button!, { target: { value: 'Go' } });
      expect(buttonTextOf(editor.definition.blocks.find((b) => b.id === note.id))).toBe('Go');
      fireEvent.change(button!, { target: { value: '' } });
      expect(buttonTextOf(editor.definition.blocks.find((b) => b.id === note.id))).toBeUndefined();
    });

    it('describes the group contents', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: group.id } });
      const view = render(<PropertiesPanel />);
      expect(screen.getByRole('heading', { name: tp.group })).toBeTruthy();
      expect(screen.getByText(tp.groupHint)).toBeTruthy();
      view.unmount();

      const empty = createGroup({ ref: 'empty_group' });
      editor = fakeEditor({ selection: { kind: 'block', id: empty.id }, definition: { ...createBlankDefinition(), blocks: [empty] } });
      render(<PropertiesPanel />);
      expect(screen.getByText(tp.groupEmpty)).toBeTruthy();
    });
  });

  describe('a page break', () => {
    beforeEach(() => {
      editor = fakeEditor({ selection: { kind: 'block', id: pageBreak.id } });
    });

    it('edits its title and has no duplicate action', () => {
      render(<PropertiesPanel />);
      expect(screen.getByRole('heading', { name: tp.pageBreak })).toBeTruthy();
      expect(screen.getByText(tp.pageBreakHelp)).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Page two' } });
      expect(editor.definition.blocks.find((b) => b.id === pageBreak.id)?.title).toBe('Page two');
      openMenu(tp.pageBreak);
      expect(screen.queryByRole('menuitem', { name: to.duplicate })).toBeNull();
      expect(screen.getByRole('menuitem', { name: to.moveDown }).getAttribute('aria-disabled')).toBe('true');
    });

    it('has no menu when read-only', () => {
      editor = fakeEditor({ selection: { kind: 'block', id: pageBreak.id }, canEdit: false });
      render(<PropertiesPanel />);
      expect(screen.queryByRole('button', { name: `${en.common.actions.openMenu}: ${tp.pageBreak}` })).toBeNull();
    });
  });

  describe('the welcome screen', () => {
    beforeEach(() => {
      editor = fakeEditor({ selection: { kind: 'welcome' }, definition: { ...createBlankDefinition(), blocks: [first], welcome: { title: 'Hello', description: 'Intro', buttonText: 'Start' } } });
    });

    it('edits title, description and button text', () => {
      render(<PropertiesPanel />);
      expect(screen.getByRole('heading', { name: tp.welcomeScreen })).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox', { name: tp.title }), { target: { value: 'Hi' } });
      expect(editor.definition.welcome?.title).toBe('Hi');
      fireEvent.change(screen.getByRole('textbox', { name: tp.description }), { target: { value: '' } });
      expect(editor.definition.welcome?.description).toBeUndefined();
      const button = screen.getByDisplayValue('Start');
      fireEvent.change(button, { target: { value: 'Begin' } });
      expect(editor.definition.welcome?.buttonText).toBe('Begin');
      fireEvent.change(button, { target: { value: '' } });
      expect(editor.definition.welcome?.buttonText).toBeUndefined();
    });

    it('removes the welcome screen and clears the selection', () => {
      render(<PropertiesPanel />);
      openMenu(tp.welcomeScreen);
      fireEvent.click(screen.getByRole('menuitem', { name: tp.removeBlock }));
      expect(editor.definition.welcome).toBeNull();
      expect(editor.select).toHaveBeenCalledWith(null);
    });

    it('has no menu when read-only', () => {
      editor = fakeEditor({ selection: { kind: 'welcome' }, canEdit: false, definition: { ...createBlankDefinition(), welcome: { title: 'Hello' } } });
      render(<PropertiesPanel />);
      expect(screen.queryByRole('button', { name: `${en.common.actions.openMenu}: ${tp.welcomeScreen}` })).toBeNull();
    });

    it('renders nothing when the welcome screen was removed', () => {
      editor = fakeEditor({ selection: { kind: 'welcome' } });
      const { container } = render(<PropertiesPanel />);
      expect(container.textContent).toBe('');
    });
  });

  describe('an ending', () => {
    const extra = createEnding({ ref: 'second_end', title: 'Bye' });

    function twoEndings() {
      const base = createBlankDefinition();
      return { ...base, endings: [...base.endings, extra] };
    }

    it('edits title, description, quiz toggles and link fields', () => {
      const def = twoEndings();
      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: def });
      render(<PropertiesPanel />);
      expect(screen.getByRole('heading', { name: tp.ending })).toBeTruthy();
      fireEvent.change(screen.getByRole('textbox', { name: tp.title }), { target: { value: 'Done' } });
      expect(editor.definition.endings[0]?.title).toBe('Done');
      fireEvent.change(screen.getByRole('textbox', { name: tp.description }), { target: { value: 'Text' } });
      expect(editor.definition.endings[0]?.description).toBe('Text');
      fireEvent.click(screen.getByRole('switch', { name: tp.showScore }));
      fireEvent.click(screen.getByRole('switch', { name: tp.showAnswers }));
      expect(editor.definition.endings[0]?.showScore).toBe(true);
      expect(editor.definition.endings[0]?.showAnswers).toBe(true);
      fireEvent.change(screen.getByRole('textbox', { name: tp.redirectUrl }), { target: { value: 'https://example.com' } });
      expect(editor.definition.endings[0]?.redirectUrl).toBe('https://example.com');
    });

    it('edits the ending button text and link', () => {
      const def = twoEndings();
      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: def });
      const view = render(<PropertiesPanel />);
      const inputs = screen.getAllByRole('textbox').filter((el) => el.tagName === 'INPUT');
      const text = inputs.find((el) => (el as HTMLInputElement).maxLength === 60)!;
      fireEvent.change(text, { target: { value: 'Visit' } });
      expect(editor.definition.endings[0]?.button).toEqual({ text: 'Visit', url: '' });
      view.unmount();

      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: def });
      const second = render(<PropertiesPanel />);
      const url = screen.getAllByPlaceholderText('https://').find((el) => (el as HTMLInputElement).maxLength === 2000 && el.tagName === 'INPUT' && el.getAttribute('aria-label') === null)!;
      fireEvent.change(url, { target: { value: 'https://weld.test' } });
      expect(editor.definition.endings[0]?.button).toEqual({ text: '', url: 'https://weld.test' });
      second.unmount();

      const withButton = { ...def, endings: [{ ...def.endings[0]!, button: { text: '', url: 'https://old.test' } }, extra] };
      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: withButton });
      render(<PropertiesPanel />);
      fireEvent.change(screen.getByDisplayValue('https://old.test'), { target: { value: '' } });
      expect(editor.definition.endings[0]?.button).toBeUndefined();
    });

    it('flags a link that is not allowed', () => {
      const def = createBlankDefinition();
      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: { ...def, endings: [{ ...def.endings[0]!, redirectUrl: 'javascript:alert(1)' }] } });
      render(<PropertiesPanel />);
      expect(screen.getAllByText(tp.linkScheme).length).toBeGreaterThan(0);
    });

    it('removes an ending when more than one exists', () => {
      const def = twoEndings();
      editor = fakeEditor({ selection: { kind: 'ending', id: extra.id }, definition: def });
      render(<PropertiesPanel />);
      openMenu(tp.ending);
      fireEvent.click(screen.getByRole('menuitem', { name: tp.removeBlock }));
      expect(editor.definition.endings).toHaveLength(1);
      expect(editor.select).toHaveBeenCalledWith(null);
    });

    it('cannot remove the only ending', () => {
      const def = createBlankDefinition();
      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: def });
      render(<PropertiesPanel />);
      expect(screen.queryByRole('button', { name: `${en.common.actions.openMenu}: ${tp.ending}` })).toBeNull();
    });

    it('edits the ending reference', () => {
      const def = createBlankDefinition();
      editor = fakeEditor({ selection: { kind: 'ending', id: def.endings[0]!.id }, definition: def });
      render(<PropertiesPanel />);
      const ref = screen.getByDisplayValue('thank_you');
      fireEvent.focus(ref);
      fireEvent.change(ref, { target: { value: 'all_done' } });
      expect(editor.definition.endings[0]?.ref).toBe('all_done');
    });
  });
});
