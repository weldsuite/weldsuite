import { useState, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { colLabel } from './types';
import type { CellCoord } from './types';
import { isFormula } from './formula-engine';

interface FormulaBarProps {
  selectedCell: CellCoord | null;
  cellValue: string;
  onCellValueChange: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function FormulaBar({
  selectedCell,
  cellValue,
  onCellValueChange,
  onCommit,
  onCancel,
}: FormulaBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(cellValue);

  useEffect(() => {
    setLocalValue(cellValue);
  }, [cellValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit(localValue);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setLocalValue(cellValue);
      onCancel();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      onCommit(localValue);
    }
  }, [localValue, cellValue, onCommit, onCancel]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalValue(val);
    onCellValueChange(val);
  }, [onCellValueChange]);

  const cellName = selectedCell
    ? `${colLabel(selectedCell.col)}${selectedCell.row + 1}`
    : '';

  return (
    <div className="bg-background flex items-center border-b h-7 shrink-0">
      {/* Cell name */}
      <div className="flex items-center justify-center border-r px-2 min-w-[51px] h-full text-xs font-medium text-muted-foreground select-none">
        {cellName}
      </div>

      {/* fx label */}
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground italic select-none">
        {isFormula(localValue) ? 'fx' : ''}
      </div>

      {/* Formula/value input */}
      <input
        ref={inputRef}
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="flex-1 h-full text-xs bg-transparent outline-none px-2 text-foreground"
        placeholder={selectedCell ? t.projects.table.formulaPlaceholder : ''}
        spellCheck={false}
      />
    </div>
  );
}
