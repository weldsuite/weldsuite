"use client"

import * as React from 'react';
import { useRef, useCallback, useState, useMemo, useEffect } from 'react';
import { Input } from '../../input';
import { Textarea } from '../../textarea';
import { Button } from '../../button';
import { Variable } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { VariablePicker, buildAllVariables, type VariableGroup } from './variable-picker';

interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  triggerType?: string;
  steps?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  workflowVariables?: Array<{
    name: string;
    type?: string;
  }>;
  extraVariableGroups?: VariableGroup[];
  excludeGroups?: string[];
  /** i18n label for the "Insert" button. */
  insertButtonLabel?: string;
}

export function VariableInput({
  value,
  onChange,
  placeholder,
  className,
  multiline = false,
  rows = 3,
  disabled = false,
  triggerType,
  steps = [],
  workflowVariables = [],
  extraVariableGroups,
  excludeGroups,
  insertButtonLabel,
  inputRef: externalRef,
}: VariableInputProps & { inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null> }) {
  const internalRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const inputRef = externalRef || internalRef;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [autocomplete, setAutocomplete] = useState<{
    open: boolean;
    query: string;
    startPos: number;
  }>({ open: false, query: '', startPos: 0 });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allVariables = useMemo(
    () => buildAllVariables({ triggerType, steps, workflowVariables, extraVariableGroups, excludeGroups }),
    [triggerType, steps, workflowVariables, extraVariableGroups, excludeGroups]
  );

  const filteredVariables = useMemo(() => {
    if (!autocomplete.open) return [];
    const q = autocomplete.query.toLowerCase();
    if (!q) return allVariables;
    return allVariables.filter(
      (v) =>
        v.path.toLowerCase().includes(q) ||
        v.label.toLowerCase().includes(q) ||
        v.group.toLowerCase().includes(q)
    );
  }, [allVariables, autocomplete.open, autocomplete.query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredVariables.length, autocomplete.query]);

  useEffect(() => {
    if (!autocomplete.open) return;
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setAutocomplete((prev) => ({ ...prev, open: false }));
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [autocomplete.open]);

  const handleInputChange = useCallback(
    (newValue: string) => {
      onChange(newValue);

      const input = inputRef.current;
      if (!input) return;

      setTimeout(() => {
        const cursorPos = input.selectionStart || 0;
        const textBefore = newValue.substring(0, cursorPos);
        const lastOpen = textBefore.lastIndexOf('{{');
        if (lastOpen === -1) {
          setAutocomplete((prev) => ({ ...prev, open: false }));
          return;
        }
        const between = textBefore.substring(lastOpen + 2);
        if (between.includes('}}')) {
          setAutocomplete((prev) => ({ ...prev, open: false }));
          return;
        }
        setAutocomplete({ open: true, query: between, startPos: lastOpen });
      }, 0);
    },
    [onChange]
  );

  const handleAutocompleteSelect = useCallback(
    (path: string) => {
      const input = inputRef.current;
      const { startPos } = autocomplete;
      const cursorPos = input?.selectionStart || value.length;
      const newValue =
        value.substring(0, startPos) + `{{${path}}}` + value.substring(cursorPos);
      onChange(newValue);
      setAutocomplete({ open: false, query: '', startPos: 0 });

      setTimeout(() => {
        if (input) {
          const newPos = startPos + path.length + 4;
          input.setSelectionRange(newPos, newPos);
          input.focus();
        }
      }, 0);
    },
    [autocomplete, value, onChange]
  );

  const handleVariableSelect = useCallback(
    (variable: string) => {
      const input = inputRef.current;
      if (!input) {
        onChange(value + variable);
        return;
      }
      const start = input.selectionStart || 0;
      const end = input.selectionEnd || 0;
      const newValue = value.substring(0, start) + variable + value.substring(end);
      onChange(newValue);

      setTimeout(() => {
        if (input) {
          const newPos = start + variable.length;
          input.setSelectionRange(newPos, newPos);
          input.focus();
        }
      }, 0);
    },
    [value, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!autocomplete.open || filteredVariables.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => prev < filteredVariables.length - 1 ? prev + 1 : 0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => prev > 0 ? prev - 1 : filteredVariables.length - 1);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = filteredVariables[selectedIndex];
        if (selected) {
          handleAutocompleteSelect(selected.path);
        }
      } else if (e.key === 'Escape') {
        setAutocomplete((prev) => ({ ...prev, open: false }));
      }
    },
    [autocomplete.open, filteredVariables, selectedIndex, handleAutocompleteSelect]
  );

  const hasVariables = value.includes('{{') && value.includes('}}');

  const InputComponent = multiline ? Textarea : Input;

  const groupedFiltered = useMemo(() => {
    const groups: Array<{ group: string; items: Array<(typeof filteredVariables)[number] & { flatIdx: number }> }> = [];
    let idx = 0;
    for (const v of filteredVariables) {
      const item = { ...v, flatIdx: idx++ };
      const existing = groups.find((g) => g.group === v.group);
      if (existing) {
        existing.items.push(item);
      } else {
        groups.push({ group: v.group, items: [item] });
      }
    }
    return groups;
  }, [filteredVariables]);

  return (
    <div className="relative">
      <InputComponent
        ref={inputRef as any}
        value={value}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={multiline ? rows : undefined}
        className={cn('pr-20', hasVariables && 'font-mono text-sm', className)}
      />
      <div className="absolute right-1 top-1">
        <VariablePicker
          triggerType={triggerType}
          steps={steps}
          workflowVariables={workflowVariables}
          extraVariableGroups={extraVariableGroups}
          excludeGroups={excludeGroups}
          onSelect={handleVariableSelect}
          labels={{ insertButton: insertButtonLabel }}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-1 hover:bg-muted"
              disabled={disabled}
            >
              <Variable className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{insertButtonLabel || 'Insert'}</span>
            </Button>
          }
        />
      </div>

      {autocomplete.open && filteredVariables.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 left-0 right-0 mt-1 bg-popover border rounded-md shadow-md overflow-hidden"
          style={{ top: '100%' }}
        >
          <div className="max-h-[200px] overflow-y-auto p-1">
            {groupedFiltered.map((group) => (
              <div key={group.group}>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{group.group}</div>
                {group.items.map((variable) => (
                  <button
                    key={variable.path}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleAutocompleteSelect(variable.path);
                    }}
                    onMouseEnter={() => setSelectedIndex(variable.flatIdx)}
                    className={cn(
                      'w-full flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-sm',
                      variable.flatIdx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Variable className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{variable.label}</span>
                    </div>
                    <code className="text-xs text-muted-foreground shrink-0">{variable.path}</code>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function VariableText({ value, className }: { value: string; className?: string }) {
  const parts = value.split(/(\{\{[^}]+\}\})/g);
  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.match(/^\{\{[^}]+\}\}$/)) {
          return (
            <code key={index} className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1 rounded text-xs">
              {part}
            </code>
          );
        }
        return part;
      })}
    </span>
  );
}
