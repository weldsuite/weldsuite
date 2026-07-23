
import React, { useEffect, useRef, useState } from 'react';
import { Input } from '@weldsuite/ui/components/input';
import { EditorProps } from '../types';

export function PhoneEditor({
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

  // Accept only characters that make sense in a phone number:
  // digits, +, -, space, parentheses, dot, and the leading/international * or #.
  const sanitize = (raw: string) => raw.replace(/[^\d+\-\s().*#]/g, '');

  return (
    <Input
      ref={inputRef}
      type="tel"
      inputMode="tel"
      value={localValue}
      placeholder={placeholder}
      onChange={(e) => setLocalValue(sanitize(e.target.value))}
      onPaste={(e) => {
        e.preventDefault();
        const pasted = e.clipboardData.getData('text');
        setLocalValue((prev) => sanitize(prev + pasted));
      }}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      className={className || 'h-7 text-[14px] border-0 shadow-none focus-visible:ring-0 p-0 bg-transparent'}
    />
  );
}
