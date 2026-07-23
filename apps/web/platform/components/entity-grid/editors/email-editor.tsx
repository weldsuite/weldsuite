
import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { EditorProps } from '../types';

export function EmailEditor({
  value,
  onCommit,
  onCancel,
  placeholder = '',
  autoFocus = true,
  className,
}: EditorProps<string>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState<string>(value || '');

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
    <Input
      ref={inputRef}
      type="email"
      value={localValue}
      placeholder={placeholder}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      className={className || 'h-7 text-[14px] border-0 shadow-none focus-visible:ring-0 p-0 bg-transparent'}
    />
  );
}
