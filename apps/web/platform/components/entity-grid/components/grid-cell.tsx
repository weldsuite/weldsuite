
import React from 'react';
import { Check, Building, User, Star } from 'lucide-react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import { cn } from '@/lib/utils';
import { useGridContext } from '../context';
import { useIsCellEditing, setEditingCellValue } from '../editing-store';
import { GridColumnDef } from '../types';
import {
  TextEditor,
  EmailEditor,
  PhoneEditor,
  NumberEditor,
  CurrencyEditor,
  DateEditor,
  SelectEditor,
  MultiSelectEditor,
  CheckboxEditor,
  LocationEditor,
  UrlEditor,
} from '../editors';
import { formatCurrency, formatDate, formatPercent } from '../utils/calculations';

interface GridCellProps<TEntity> {
  entity: TEntity;
  column: GridColumnDef<TEntity>;
  isFirstColumn: boolean;
}

// Cell wrapper component
const CellWrapper: React.FC<{
  children: React.ReactNode;
  onClick?: () => void;
  isFirstColumn?: boolean;
  compact?: boolean;
  isEditing?: boolean;
}> = ({ children, onClick, isFirstColumn, compact, isEditing }) => (
  <div
    onClick={onClick}
    className="group/cell"
    style={{
      height: compact ? '21px' : '40px',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden',
      padding: isFirstColumn
        ? compact ? '0 6px 0 8px' : '0 12px 0 20px'
        : compact ? '0 6px' : '0 12px',
      cursor: onClick ? 'pointer' : 'default',
      fontSize: compact ? '12px' : undefined,
      boxShadow: isEditing ? '0 0 0 1px color-mix(in srgb, var(--border) 70%, var(--foreground) 30%)' : undefined,
      position: isEditing ? 'relative' : undefined,
      zIndex: isEditing ? 1 : undefined,
    }}
  >
    <div
      style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      {children}
    </div>
  </div>
);

export function GridCell<TEntity>({
  entity,
  column,
  isFirstColumn,
}: GridCellProps<TEntity>) {
  const {
    config,
    state,
    setSelectedRows,
    setEditValue,
    setOpenPopover,
    setOptimisticUpdates,
    updateEntityField,
    updateCustomFieldValue,
    getCustomFieldValue,
    actions,
  } = useGridContext<TEntity>();

  const { selectedRows, editValue, openPopover } = state;
  const compact = !!config.fillViewport;
  const entityId = config.getEntityId(entity);
  const value = column.getValue(entity);
  // Subscribe only to this cell's editing flag — other cells don't re-render when
  // another cell enters edit mode.
  const isEditing = useIsCellEditing(entityId, column.id);
  const isPopoverOpen =
    openPopover?.rowId === entityId && openPopover?.fieldId === column.id;

  // Local-only custom columns (created via addColumn) store in customFieldData.
  // Server-backed custom fields (from customFieldDefs, id starts with cf_) persist via updateEntityField.
  const isLocalOnly = column.isCustom && column.id.startsWith('custom_');

  const persistValue = (newValue: any) => {
    if (isLocalOnly) {
      updateCustomFieldValue(entityId, column.id, newValue);
    } else {
      updateEntityField(entityId, column.id, newValue);
    }
  };

  // Handle commit for editors. Editors may pass the final value directly
  // (uncontrolled pattern) to avoid re-rendering the entire grid on each keystroke.
  const handleCommit = (finalValue?: any) => {
    const committedValue = finalValue !== undefined ? finalValue : editValue;
    if (isLocalOnly || committedValue !== value) {
      persistValue(committedValue);
    }
    setEditingCellValue(null);
  };

  const handleCancel = () => {
    setEditingCellValue(null);
  };

  // Custom render function takes precedence over type-based rendering
  if (column.render) {
    return (
      <CellWrapper isFirstColumn={isFirstColumn} compact={compact}>
        {column.render(entity, value)}
      </CellWrapper>
    );
  }

  // Render company/name column (special case - first column with avatar)
  if (column.type === 'company' && isFirstColumn) {
    const name = config.getEntityName(entity);
    const initials = config.getEntityInitials?.(entity) || name.charAt(0).toUpperCase();
    const avatar = config.getEntityAvatar?.(entity);
    const subtitle = config.getEntitySubtitle?.(entity);
    const contextMenuItems = config.renderRowContextMenu?.(entity);

    const cell = (
      <CellWrapper onClick={() => actions.onRowClick?.(entity)} isFirstColumn compact={compact}>
        <div className="flex items-center gap-2.5 min-w-0 flex-1 group">
          {config.enableRowSelection !== false && (
            <Checkbox
              checked={selectedRows.has(entityId)}
              onCheckedChange={(checked) => {
                const newSelected = new Set(selectedRows);
                if (checked) {
                  newSelected.add(entityId);
                } else {
                  newSelected.delete(entityId);
                }
                setSelectedRows(newSelected);
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-shrink-0 rounded-[5px]"
            />
          )}
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <Avatar className="h-[22px] w-[22px] rounded-md border border-border flex-shrink-0">
              <AvatarImage src={avatar} />
              <AvatarFallback className="rounded-md bg-muted text-[10px] font-medium">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <span className="font-medium text-[14px] text-foreground group-hover:text-primary truncate block">
                {name}
              </span>
              {subtitle && (
                <span className="text-[12px] text-muted-foreground truncate block">
                  {subtitle}
                </span>
              )}
            </div>
          </div>
        </div>
        {column.favoriteField && (
          <Button
            variant="ghost"
            size="icon"
            // Don't let the press bubble to the cell's onMouseDown — that
            // starts a cell-range selection, which stamps
            // `body[data-grid-dragging]` and the global CSS rule then hides
            // this hover-only star between mousedown and mouseup. With the
            // button gone, the click lands on the row instead and opens the
            // object panel rather than toggling the favorite.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation();
              const field = column.favoriteField!;
              const newVal = !(entity as any)[field];
              const prev = state.optimisticUpdates;
              setOptimisticUpdates({
                ...prev,
                [entityId]: { ...prev[entityId], [field]: newVal } as Partial<TEntity>,
              });
              const result = await actions.onUpdateEntity(entityId, { [field]: newVal });
              if (!result.success) {
                const cur = state.optimisticUpdates;
                setOptimisticUpdates({
                  ...cur,
                  [entityId]: { ...cur[entityId], [field]: !newVal } as Partial<TEntity>,
                });
              }
            }}
            // `data-grid-hover-only` flags this as a hover-revealed ornament,
            // so the global cell-drag CSS rule can suppress it while a drag
            // selection is in flight (it would otherwise blink in/out as
            // the cursor crosses rows).
            data-grid-hover-only={(entity as any)[column.favoriteField!] ? undefined : 'true'}
            data-testid="entity-grid-favorite"
            aria-pressed={!!(entity as any)[column.favoriteField!]}
            className={cn(
              "p-0.5 rounded-[5px] transition-colors hover:bg-muted flex-shrink-0",
              (entity as any)[column.favoriteField!]
                ? "inline-flex"
                : "hidden group-hover:inline-flex"
            )}
          >
            <Star
              className={cn(
                "h-4 w-4",
                (entity as any)[column.favoriteField!]
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-muted-foreground/30 hover:text-muted-foreground/60"
              )}
            />
          </Button>
        )}
      </CellWrapper>
    );

    if (contextMenuItems) {
      return (
        <ContextMenu>
          <ContextMenuTrigger className="block w-full h-full data-[state=open]:bg-muted/50">
            {cell}
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">{contextMenuItems}</ContextMenuContent>
        </ContextMenu>
      );
    }
    return cell;
  }

  // Render based on field type
  switch (column.type) {
    case 'checkbox':
      return (
        <CellWrapper isFirstColumn={isFirstColumn} compact={compact}>
          <CheckboxEditor
            value={value || false}
            onChange={(newValue) => persistValue(newValue)}
            onCommit={() => {}}
            onCancel={() => {}}
          />
        </CellWrapper>
      );

    case 'star':
      return (
        <CellWrapper isFirstColumn={isFirstColumn} compact={compact}>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              persistValue(!value);
            }}
            className="p-0.5 rounded transition-colors hover:bg-muted"
          >
            <Star
              className={cn(
                "h-4 w-4 transition-colors",
                value
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-muted-foreground/30 hover:text-muted-foreground/60"
              )}
            />
          </Button>
        </CellWrapper>
      );

    case 'email':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <EmailEditor
              value={value || ''}
              onCommit={handleCommit}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] text-foreground/80 truncate">
            {value || null}
          </span>
        </CellWrapper>
      );

    case 'phone':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <PhoneEditor
              value={value || ''}
              onCommit={handleCommit}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] text-foreground/80 truncate">
            {value || null}
          </span>
        </CellWrapper>
      );

    case 'text':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <TextEditor
              value={value || ''}
              onCommit={handleCommit}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] text-foreground/80 truncate">
            {value || null}
          </span>
        </CellWrapper>
      );

    case 'url':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <UrlEditor
              value={value || ''}
              onCommit={handleCommit}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] text-foreground/80 truncate">
            {value || null}
          </span>
        </CellWrapper>
      );

    case 'number':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <NumberEditor
              value={value > 0 ? value : ''}
              onCommit={(finalValue) => {
                const newValue = parseFloat(String(finalValue ?? '')) || 0;
                if (newValue !== value) persistValue(newValue);
                setEditingCellValue(null);
              }}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] text-foreground/80">
            {value != null && value !== '' ? value.toLocaleString() : null}
          </span>
        </CellWrapper>
      );

    case 'currency':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <CurrencyEditor
              value={value > 0 ? value : ''}
              onCommit={(finalValue) => {
                const newValue = parseFloat(String(finalValue ?? '')) || 0;
                if (newValue !== value) persistValue(newValue);
                setEditingCellValue(null);
              }}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] font-medium text-foreground">
            {value > 0 ? formatCurrency(value, { compact: true }) : null}
          </span>
        </CellWrapper>
      );

    case 'percent':
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <NumberEditor
              value={value > 0 ? value : ''}
              onCommit={(finalValue) => {
                const newValue = parseFloat(String(finalValue ?? '')) || 0;
                if (newValue !== value) persistValue(newValue);
                setEditingCellValue(null);
              }}
              onCancel={handleCancel}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            if (config.enableInlineEditing !== false) {
              setEditingCellValue({ rowId: entityId, fieldId: column.id });
            }
          }}
        >
          <span className="text-[14px] text-foreground/80">
            {value != null && value !== '' ? formatPercent(value) : null}
          </span>
        </CellWrapper>
      );

    case 'date':
      return (
        <CellWrapper isFirstColumn={isFirstColumn} compact={compact}>
          <DateEditor
            value={value}
            onChange={(newValue) => {
              if (isLocalOnly) {
                updateCustomFieldValue(entityId, column.id, newValue);
              } else {
                updateEntityField(entityId, column.id, newValue?.toISOString() || null);
              }
            }}
            onCommit={() => {}}
            onCancel={() => {}}
          />
        </CellWrapper>
      );

    case 'single-select': {
      const isPopoverOpen =
        openPopover?.rowId === entityId && openPopover?.fieldId === column.id;
      return (
        <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing={isPopoverOpen}>
          <SelectEditor
            value={value}
            onChange={(newValue) => persistValue(newValue)}
            onCommit={() => {}}
            onCancel={() => {}}
            options={column.options || []}
            optionConfig={column.selectConfig}
            onOpenChange={(open) =>
              setOpenPopover(open ? { rowId: entityId, fieldId: column.id } : null)
            }
          />
        </CellWrapper>
      );
    }

    case 'multi-select': {
      const isPopoverOpen =
        openPopover?.rowId === entityId && openPopover?.fieldId === column.id;
      return (
        <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing={isPopoverOpen}>
          <MultiSelectEditor
            value={value || []}
            onChange={(newValue) => persistValue(newValue)}
            onCommit={() => {}}
            onCancel={() => {}}
            options={column.options || []}
            optionConfig={column.selectConfig}
            onOpenChange={(open) =>
              setOpenPopover(open ? { rowId: entityId, fieldId: column.id } : null)
            }
          />
        </CellWrapper>
      );
    }

    case 'location': {
      const displayText = (() => {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'object') {
          const v = value as { city?: string; state?: string; country?: string };
          return [v.city, v.state, v.country].filter(Boolean).join(', ');
        }
        return '';
      })();
      if (isEditing) {
        return (
          <CellWrapper isFirstColumn={isFirstColumn} compact={compact} isEditing>
            <LocationEditor
              value={value}
              onChange={(newValue) => persistValue(newValue)}
              onCommit={() => setEditingCellValue(null)}
              onCancel={() => setEditingCellValue(null)}
            />
          </CellWrapper>
        );
      }
      return (
        <CellWrapper
          isFirstColumn={isFirstColumn}
          compact={compact}
          onClick={() => {
            setEditingCellValue({ rowId: entityId, fieldId: column.id });
          }}
        >
          {displayText ? (
            <span className="text-[14px] text-foreground/80 truncate">{displayText}</span>
          ) : null}
        </CellWrapper>
      );
    }

    default:
      return (
        <CellWrapper isFirstColumn={isFirstColumn} compact={compact}>
          <span className="text-[14px] text-foreground/80">
            {value?.toString() || null}
          </span>
        </CellWrapper>
      );
  }
}
