import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { Plus, Pencil, Trash2, Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@/lib/utils';
import type { SpreadsheetSheet } from './use-spreadsheet';

interface SheetTabBarProps {
  sheets: SpreadsheetSheet[];
  activeSheetId: string | null;
  onSelectSheet: (sheetId: string) => void;
  onCreateSheet: (name: string) => void;
  onRenameSheet: (sheetId: string, name: string) => void;
  onDeleteSheet: (sheetId: string) => void;
  onDuplicateSheet: (sheetId: string, name: string) => void;
  onReorderSheets?: (sheetIds: string[]) => void;
}

export function SheetTabBar({
  sheets,
  activeSheetId,
  onSelectSheet,
  onCreateSheet,
  onRenameSheet,
  onDeleteSheet,
  onDuplicateSheet,
  onReorderSheets,
}: SheetTabBarProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [menuSheetId, setMenuSheetId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuSheetId) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuSheetId(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuSheetId(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuSheetId]);

  const startRename = (sheet: SpreadsheetSheet) => {
    setEditingId(sheet.id);
    setEditValue(sheet.name);
    setMenuSheetId(null);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameSheet(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const handleAddSheet = () => {
    const nextNum = sheets.length + 1;
    onCreateSheet(`Sheet ${nextNum}`);
  };

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, sheetId: string) => {
    setDragId(sheetId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sheetId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, sheetId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragId && sheetId !== dragId) {
      setDragOverId(sheetId);
    }
  }, [dragId]);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    if (!dragId || dragId === targetId || !onReorderSheets) {
      setDragId(null);
      return;
    }

    const sortedSheets = [...sheets].sort((a, b) => a.position - b.position);
    const ids = sortedSheets.map(s => s.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) {
      setDragId(null);
      return;
    }

    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragId);
    onReorderSheets(ids);
    setDragId(null);
  }, [dragId, sheets, onReorderSheets]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  const menuSheet = menuSheetId ? sheets.find(s => s.id === menuSheetId) : null;

  return (
    <div className="flex items-center px-1 py-1 gap-0.5 overflow-x-auto flex-1 min-w-0 relative" onContextMenu={(e) => e.stopPropagation()}>
      {sheets.map((sheet) => {
        const isActive = sheet.id === activeSheetId;
        const isEditing = editingId === sheet.id;
        const isDragging = dragId === sheet.id;
        const isDragOver = dragOverId === sheet.id;

        return (
          <div
            key={sheet.id}
            draggable={!isEditing}
            onDragStart={(e) => handleDragStart(e, sheet.id)}
            onDragOver={(e) => handleDragOver(e, sheet.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, sheet.id)}
            onDragEnd={handleDragEnd}
            className={cn(
              'flex items-center px-3 py-1.5 text-sm rounded-md cursor-pointer select-none min-w-0 shrink-0 transition-opacity',
              isActive
                ? 'bg-background text-foreground border'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              isDragging && 'opacity-40',
              isDragOver && 'border-l-2 border-l-primary',
            )}
            onClick={() => !isEditing && onSelectSheet(sheet.id)}
            onDoubleClick={() => startRename(sheet)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenuSheetId(sheet.id);
              setMenuPos({ x: e.clientX, y: e.clientY });
            }}
          >
            {isEditing ? (
              <Input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="h-5 w-24 text-sm px-1 py-0"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="truncate max-w-[120px]">{sheet.name}</span>
            )}
          </div>
        );
      })}

      {/* Right-click context menu */}
      {menuSheet && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-md border bg-popover p-1 shadow-md"
          style={{ left: menuPos.x, bottom: window.innerHeight - menuPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground h-auto justify-start"
            onClick={() => startRename(menuSheet)}
          >
            <Pencil className="h-3.5 w-3.5 mr-2" />
            {t.projects.table.renameSheet}
          </Button>
          <Button
            variant="ghost"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground h-auto justify-start"
            onClick={() => { onDuplicateSheet(menuSheet.id, `${menuSheet.name} (copy)`); setMenuSheetId(null); }}
          >
            <Copy className="h-3.5 w-3.5 mr-2" />
            {t.projects.table.duplicateSheet}
          </Button>
          {sheets.length > 1 && (
            <Button
              variant="ghost"
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 h-auto justify-start"
              onClick={() => { onDeleteSheet(menuSheet.id); setMenuSheetId(null); }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              {t.projects.table.deleteSheet}
            </Button>
          )}
        </div>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 shrink-0 text-muted-foreground"
        onClick={handleAddSheet}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
