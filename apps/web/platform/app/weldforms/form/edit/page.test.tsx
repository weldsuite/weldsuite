import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { createBlankDefinition, createField, createGroup, type FormDefinition } from '@weldsuite/forms-engine';
import type { FormEditor, Selection } from '../editor-context';
import CreateTab from './page';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

let editor: FormEditor;
vi.mock('../editor-context', () => ({
  useFormEditor: () => editor,
}));

vi.mock('../../lib/use-effective-theme', () => ({
  useEffectiveTheme: () => ({ tokens: { fake: 'tokens' } }),
}));

vi.mock('../../components/form-preview', () => ({
  FormPreview: (props: { layout: string; device: string; startAtBlockId?: string; resetKey: string }) => (
    <div data-testid="preview" data-layout={props.layout} data-device={props.device} data-start={props.startAtBlockId ?? ''} data-reset={props.resetKey} />
  ),
}));

vi.mock('./outline', () => ({
  Outline: ({ onDataClick }: { onDataClick: () => void }) => (
    <button type="button" onClick={onDataClick}>
      outline stub
    </button>
  ),
}));
vi.mock('./properties-panel', () => ({
  PropertiesPanel: () => <div>properties stub</div>,
}));
vi.mock('./data-dialog', () => ({
  DataDialog: ({ open }: { open: boolean }) => (open ? <div>data dialog open</div> : null),
}));

const te = en.weldforms.editor;

const first = createField('short_text', { title: 'Name', ref: 'name' });
const group = { ...createGroup({ ref: 'g' }), children: [createField('email', { ref: 'mail' })] };

function fakeEditor(over: { definition?: FormDefinition; selection?: Selection; canEdit?: boolean } = {}): FormEditor {
  return {
    definition: over.definition ?? { ...createBlankDefinition(), blocks: [first, group] },
    selection: over.selection ?? null,
    canEdit: over.canEdit ?? true,
    draft: { themeId: null },
  } as unknown as FormEditor;
}

const preview = () => screen.getByTestId('preview');

describe('Create tab', () => {
  beforeEach(() => {
    editor = fakeEditor();
  });

  it('renders the outline, preview and properties panes', () => {
    render(<CreateTab />);
    expect(screen.getByLabelText(te.paneOutline, { selector: 'aside' })).toBeTruthy();
    expect(screen.getByLabelText(te.panePreview, { selector: 'main' })).toBeTruthy();
    expect(screen.getByLabelText(te.paneProperties, { selector: 'aside' })).toBeTruthy();
    expect(screen.getByText('outline stub')).toBeTruthy();
    expect(screen.getByText('properties stub')).toBeTruthy();
    expect(screen.queryByText(te.readOnly)).toBeNull();
  });

  it('shows a read-only note without edit rights', () => {
    editor = fakeEditor({ canEdit: false });
    render(<CreateTab />);
    expect(screen.getByText(te.readOnly)).toBeTruthy();
  });

  it('previews in the definition layout and switches layout from the dropdown', () => {
    render(<CreateTab />);
    expect(preview().dataset.layout).toBe('conversational');
    const trigger = screen.getByRole('button', { name: `${te.previewLayout}: ${te.conversational}` });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: te.classic }));
    expect(preview().dataset.layout).toBe('classic');
    expect(screen.getByRole('button', { name: `${te.previewLayout}: ${te.classic}` })).toBeTruthy();
  });

  it('starts from the definition layout when it is classic', () => {
    editor = fakeEditor({ definition: { ...createBlankDefinition(), blocks: [first], presentation: { ...createBlankDefinition().presentation, layout: 'classic' } } });
    render(<CreateTab />);
    expect(preview().dataset.layout).toBe('classic');
  });

  it('switches the preview between desktop and phone', () => {
    render(<CreateTab />);
    expect(preview().dataset.device).toBe('desktop');
    fireEvent.click(screen.getByRole('radio', { name: en.weldforms.preview.phone }));
    expect(preview().dataset.device).toBe('phone');
    fireEvent.click(screen.getByRole('radio', { name: en.weldforms.preview.desktop }));
    expect(preview().dataset.device).toBe('desktop');
  });

  it('keeps the device when the active toggle is clicked again', () => {
    render(<CreateTab />);
    fireEvent.click(screen.getByRole('radio', { name: en.weldforms.preview.desktop }));
    expect(preview().dataset.device).toBe('desktop');
  });

  it('shows an empty message instead of the preview when there is nothing to preview', () => {
    editor = fakeEditor({ definition: createBlankDefinition() });
    render(<CreateTab />);
    expect(screen.getByText(te.previewEmpty)).toBeTruthy();
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('previews a form that only has a welcome screen', () => {
    editor = fakeEditor({ definition: { ...createBlankDefinition(), welcome: { title: 'Hi' } } });
    render(<CreateTab />);
    expect(screen.getByTestId('preview')).toBeTruthy();
  });

  it('restarts the preview at the selected block, or at its group for a nested one', () => {
    editor = fakeEditor({ selection: { kind: 'block', id: first.id } });
    const view = render(<CreateTab />);
    expect(preview().dataset.start).toBe(first.id);
    expect(preview().dataset.reset).toBe(`block:${first.id}`);
    view.unmount();

    editor = fakeEditor({ selection: { kind: 'block', id: group.children[0]!.id } });
    render(<CreateTab />);
    expect(preview().dataset.start).toBe(group.id);
  });

  it('keys the preview on welcome, ending and empty selections without a start block', () => {
    editor = fakeEditor({ selection: { kind: 'welcome' } });
    const welcome = render(<CreateTab />);
    expect(preview().dataset.reset).toBe('welcome:');
    expect(preview().dataset.start).toBe('');
    welcome.unmount();

    editor = fakeEditor({ selection: { kind: 'ending', id: 'e1' } });
    const ending = render(<CreateTab />);
    expect(preview().dataset.reset).toBe('ending:e1');
    ending.unmount();

    editor = fakeEditor();
    render(<CreateTab />);
    expect(preview().dataset.reset).toBe('');
  });

  it('switches panes with the tab bar on small screens', () => {
    render(<CreateTab />);
    const outlineTab = screen.getByRole('tab', { name: te.paneOutline });
    expect(outlineTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: te.panePreview }));
    expect(screen.getByRole('tab', { name: te.panePreview }).getAttribute('aria-selected')).toBe('true');
    expect(outlineTab.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('tab', { name: te.paneProperties }));
    expect(screen.getByRole('tab', { name: te.paneProperties }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens the data dialog from the outline', () => {
    render(<CreateTab />);
    expect(screen.queryByText('data dialog open')).toBeNull();
    fireEvent.click(screen.getByText('outline stub'));
    expect(screen.getByText('data dialog open')).toBeTruthy();
  });
});
