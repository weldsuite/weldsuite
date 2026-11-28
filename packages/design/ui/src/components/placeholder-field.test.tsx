import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlaceholderField } from './placeholder-field';

const PLACEHOLDERS = [
  { key: 'customerName', label: 'Customer name' },
  { key: 'number', label: 'Invoice number' },
];

function Harness({ initial, multiline }: Readonly<{ initial: string; multiline?: boolean }>) {
  const [value, setValue] = useState(initial);
  return (
    <PlaceholderField
      aria-label="Text"
      value={value}
      onChange={setValue}
      placeholders={PLACEHOLDERS}
      insertLabel="Insert"
      chipsLabel="Placeholders"
      multiline={multiline}
    />
  );
}

describe('PlaceholderField', () => {
  afterEach(cleanup);

  it('inserts a placeholder at the cursor', () => {
    render(<Harness initial="Dear ," />);
    const field = screen.getByLabelText('Text') as HTMLTextAreaElement;
    field.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Insert Customer name' }));
    expect(field.value).toBe('Dear {customerName},');
  });

  it('replaces the selected text, in a one-line field too', () => {
    render(<Harness initial="Invoice XXX" multiline={false} />);
    const field = screen.getByLabelText('Text') as HTMLInputElement;
    field.setSelectionRange(8, 11);
    fireEvent.click(screen.getByRole('button', { name: 'Insert Invoice number' }));
    expect(field.value).toBe('Invoice {number}');
  });

  it('groups the chips under a name', () => {
    render(<Harness initial="" />);
    expect(screen.getByRole('group', { name: 'Placeholders' })).not.toBeNull();
  });
});
