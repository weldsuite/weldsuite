import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VariantOptionsEditor } from './variant-options-editor';

function setup(initialOptions = [{ name: 'Size', values: ['S', 'M'] }], isGenerating = false) {
  const onGenerate = vi.fn();
  const onCancel = vi.fn();
  render(
    <VariantOptionsEditor
      initialOptions={initialOptions}
      onGenerate={onGenerate}
      onCancel={onCancel}
      isGenerating={isGenerating}
    />,
  );
  return { onGenerate, onCancel, user: userEvent.setup() };
}

const generate = () => screen.getByRole('button', { name: 'Generate variants' });

describe('VariantOptionsEditor', () => {
  it('starts from the existing options and counts the variants they make', () => {
    setup([
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Colour', values: ['Red', 'Blue'] },
    ]);
    expect(screen.getAllByLabelText('Option name').map((el) => (el as HTMLInputElement).value)).toEqual(['Size', 'Colour']);
    expect(screen.getByText('Makes 6 variants')).toBeInTheDocument();
    expect(generate()).toBeEnabled();
  });

  it('starts with one empty option for a product without variants', () => {
    setup([]);
    expect(screen.getAllByLabelText('Option name')).toHaveLength(1);
    expect(screen.getByText('Give every option a name and at least one value.')).toBeInTheDocument();
    expect(generate()).toBeDisabled();
  });

  it('adds values with Enter, a comma or the button, without repeats, and removes them', async () => {
    const { user, onGenerate } = setup([]);
    await user.type(screen.getByLabelText('Option name'), 'Colour');
    const value = screen.getByLabelText('Values');
    await user.type(value, 'Red{Enter}');
    await user.type(value, 'Blue,');
    await user.type(value, 'Red{Enter}');
    await user.type(value, 'Green');
    await user.click(screen.getByRole('button', { name: 'Add value' }));
    expect(screen.getByText('Makes 3 variants')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Blue' }));
    expect(screen.getByText('Makes 2 variants')).toBeInTheDocument();

    await user.click(generate());
    expect(onGenerate).toHaveBeenCalledWith([{ name: 'Colour', values: ['Red', 'Green'] }]);
  });

  it('leaves Enter and a comma to an IME that is still composing', () => {
    setup([{ name: 'Colour', values: [] }]);
    const value = screen.getByLabelText('Values');
    fireEvent.change(value, { target: { value: 'あか' } });
    // The Enter that confirms the candidate (isComposing; Safari reports only keyCode 229).
    fireEvent.keyDown(value, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(value, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(value, { key: ',', isComposing: true });
    expect(screen.queryByRole('button', { name: 'Remove あか' })).not.toBeInTheDocument();
    expect(value).toHaveValue('あか');

    fireEvent.keyDown(value, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove あか' })).toBeInTheDocument();
    expect(value).toHaveValue('');
  });

  it('keeps focus in the option when a value or option is removed', async () => {
    const { user } = setup([
      { name: 'Size', values: ['S', 'M'] },
      { name: 'Colour', values: ['Red'] },
    ]);
    // Opening focuses the first option's name; each option is a group named after it.
    expect(screen.getAllByLabelText('Option name')[0]).toHaveFocus();
    expect(screen.getByRole('group', { name: 'Colour' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove M' }));
    expect(screen.getAllByLabelText('Values')[0]).toHaveFocus();

    await user.click(screen.getAllByRole('button', { name: 'Remove option' })[1]);
    expect(screen.getAllByLabelText('Option name')[0]).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Remove option' }));
    expect(screen.getByRole('button', { name: 'Add option' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    expect(screen.getByLabelText('Option name')).toHaveFocus();
  });

  it('counts a value still typed in the field', async () => {
    const { user, onGenerate } = setup();
    await user.type(screen.getByLabelText('Values'), 'L');
    expect(screen.getByText('Makes 3 variants')).toBeInTheDocument();
    await user.click(generate());
    expect(onGenerate).toHaveBeenCalledWith([{ name: 'Size', values: ['S', 'M', 'L'] }]);
  });

  it('allows three options at most', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    expect(screen.getAllByLabelText('Option name')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Add option' })).toBeDisabled();
    expect(screen.getByText('A product can have at most 3 options.')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Remove option' })[2]);
    expect(screen.getAllByLabelText('Option name')).toHaveLength(2);
  });

  it('refuses two options with the same name', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    const names = screen.getAllByLabelText('Option name');
    await user.type(names[1], 'size');
    await user.type(screen.getAllByLabelText('Values')[1], 'XL{Enter}');
    expect(screen.getByText('Give each option a different name.')).toBeInTheDocument();
    expect(generate()).toBeDisabled();
  });

  it('refuses more than 100 combinations', () => {
    const values = Array.from({ length: 11 }, (_, i) => `v${i}`);
    setup([
      { name: 'A', values },
      { name: 'B', values },
    ]);
    expect(screen.getByText('That is more than 100 variants. Remove some values.')).toBeInTheDocument();
    expect(generate()).toBeDisabled();
  });

  it('cancels, and waits while generating', async () => {
    const { user, onCancel } = setup(undefined, true);
    expect(generate()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
