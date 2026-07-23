
import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { EditorProps } from '../types';

interface CurrencyEditorProps extends EditorProps<number | string> {
  currency?: string;
}

export function CurrencyEditor({
  value,
  onCommit,
  onCancel,
  placeholder = '',
  autoFocus = true,
  className,
  currency = '$',
}: CurrencyEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState<string>(value == null ? '' : String(value));

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  const commit = () => onCommit(localValue);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commit();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="flex items-center gap-1 w-full">
      <span className="text-[14px] text-muted-foreground">{currency}</span>
      <Input
        ref={inputRef}
        type="number"
        value={localValue}
        placeholder={placeholder}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        step="0.01"
        className={className || 'h-7 text-[14px] border-0 shadow-none focus-visible:ring-0 p-0 bg-transparent flex-1'}
      />
    </div>
  );
}
