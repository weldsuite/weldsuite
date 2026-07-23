
import React from 'react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { EditorProps } from '../types';

export function CheckboxEditor({
  value,
  onChange,
  onCommit,
}: EditorProps<boolean>) {
  const handleChange = (checked: boolean | 'indeterminate') => {
    const newValue = checked === true;
    onChange?.(newValue);
    onCommit();
  };

  return (
    <Checkbox
      checked={value || false}
      onCheckedChange={handleChange}
      className="border-border"
    />
  );
}
