import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: { weldchat: { slashCommandPalette: { commands: { createtask: 'Create a task' } } } },
  }),
}));

import { SlashCommandPalette } from './slash-command-palette';

function setup(query: string) {
  const onSelect = vi.fn();
  const onDismiss = vi.fn();
  const editorKeyDown = vi.fn();
  const ui = render(
    <div data-chat-composer-root="">
      <SlashCommandPalette query={query} onSelect={onSelect} onDismiss={onDismiss} />
      <div data-testid="editor" contentEditable suppressContentEditableWarning onKeyDown={(e) => editorKeyDown(e.key)} />
    </div>,
  );
  return { ...ui, onSelect, onDismiss, editorKeyDown };
}

describe('SlashCommandPalette keyboard', () => {
  it('Enter on a bare "/" completes the highlighted command instead of reaching the composer', () => {
    const { getByTestId, onSelect, editorKeyDown } = setup('/');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('/createtask ');
    expect(editorKeyDown).not.toHaveBeenCalled();
  });

  it('Tab completes the command too', () => {
    const { getByTestId, onSelect } = setup('/cre');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Tab' });
    expect(onSelect).toHaveBeenCalledWith('/createtask ');
  });

  it('lets Enter through when no command matches', () => {
    const { container, getByTestId, onSelect, editorKeyDown } = setup('/nope');
    expect(container.textContent).not.toContain('/createtask');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(editorKeyDown).toHaveBeenCalledWith('Enter');
  });

  it('Escape closes the palette and is consumed (it must not cancel a reply/edit)', () => {
    const { getByTestId, onDismiss, editorKeyDown } = setup('/');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(editorKeyDown).not.toHaveBeenCalled();
  });

  it('Escape reaches the composer when nothing matches', () => {
    const { getByTestId, onDismiss, editorKeyDown } = setup('/nope');
    fireEvent.keyDown(getByTestId('editor'), { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(editorKeyDown).toHaveBeenCalledWith('Escape');
  });

  it('selects on click', () => {
    const { getByText, onSelect } = setup('/');
    fireEvent.mouseDown(getByText('/createtask'));
    expect(onSelect).toHaveBeenCalledWith('/createtask ');
  });
});
