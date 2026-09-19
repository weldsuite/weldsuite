import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn } from '../cn';
import { Input } from '../input';
import type { StatusStyle } from './types';

interface BaseEditorProps<T> {
  value: T;
  onCommit: (value: T) => void;
  onCancel: () => void;
  className?: string;
}

export function TextEditor({
  value,
  onCommit,
  onCancel,
  className,
  type = 'text',
}: BaseEditorProps<string> & { type?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => onCommit(ref.current?.value ?? value);

  return (
    <Input
      ref={ref}
      type={type}
      defaultValue={value}
      className={cn('wui-egrid-editor-input', className)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export function NumberEditor({ value, onCommit, onCancel, className }: BaseEditorProps<number | null>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const raw = ref.current?.value ?? '';
    if (raw.trim() === '') {
      onCommit(null);
      return;
    }
    const n = Number(raw);
    onCommit(Number.isFinite(n) ? n : value);
  };

  return (
    <Input
      ref={ref}
      type="number"
      defaultValue={value ?? ''}
      className={cn('wui-egrid-editor-input', className)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export function SelectEditor({
  value,
  options,
  optionConfig,
  onCommit,
  onCancel,
  className,
}: BaseEditorProps<string | null> & {
  options: string[];
  optionConfig?: Record<string, StatusStyle>;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <select
      ref={ref}
      className={cn('wui-egrid-editor-select', className)}
      defaultValue={value ?? ''}
      onBlur={(e) => onCommit(e.target.value || null)}
      onChange={(e) => onCommit(e.target.value || null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <option value="">—</option>
      {options.map((opt) => (
        <option key={opt} value={opt} style={optionConfig?.[opt]?.color ? { color: optionConfig[opt].color } : undefined}>
          {optionConfig?.[opt]?.label ?? opt}
        </option>
      ))}
    </select>
  );
}

export function CheckboxEditor({
  value,
  onCommit,
}: {
  value: boolean;
  onCommit: (value: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="wui-egrid-checkbox"
      checked={!!value}
      onChange={(e) => onCommit(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
