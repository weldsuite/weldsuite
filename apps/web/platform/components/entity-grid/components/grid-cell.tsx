
import React from 'react';
import { Star } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@weldsuite/ui/components/context-menu';
import { cn } from '@/lib/utils';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { MemberSelect } from '@/components/team/member-select';
import { useGridContext } from '../context';
import { useIsCellEditing, setEditingCellValue } from '../editing-store';
import { GridColumnDef, EditorProps, OpenPopover } from '../types';
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
import { formatCurrency, formatPercent } from '../utils/calculations';
import { asText } from '@weldsuite/text';

interface GridCellProps<TEntity> {
  entity: TEntity;
  column: GridColumnDef<TEntity>;
  isFirstColumn: boolean;
}

function cellPadding(isFirstColumn?: boolean, compact?: boolean): string {
  if (isFirstColumn) return compact ? '0 6px 0 8px' : '0 12px 0 20px';
  return compact ? '0 6px' : '0 12px';
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
      padding: cellPadding(isFirstColumn, compact),
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

interface FavoriteButtonProps<TEntity> {
  entity: TEntity;
  entityId: string;
  field: string;
}

function FavoriteButton<TEntity>({ entity, entityId, field }: Readonly<FavoriteButtonProps<TEntity>>) {
  const { state, setOptimisticUpdates, actions } = useGridContext<TEntity>();
  const isFavorite = !!(entity as Record<string, unknown>)[field];

  const setFavorite = (next: boolean) => {
    const prev = state.optimisticUpdates;
    setOptimisticUpdates({
      ...prev,
      [entityId]: { ...prev[entityId], [field]: next } as Partial<TEntity>,
    });
  };

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newVal = !(entity as Record<string, unknown>)[field];
    setFavorite(newVal);
    const result = await actions.onUpdateEntity(entityId, { [field]: newVal });
    if (!result.success) {
      setFavorite(!newVal);
    }
  };

  return (
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
      onClick={toggleFavorite}
      // `data-grid-hover-only` flags this as a hover-revealed ornament,
      // so the global cell-drag CSS rule can suppress it while a drag
      // selection is in flight (it would otherwise blink in/out as
      // the cursor crosses rows).
      data-grid-hover-only={isFavorite ? undefined : 'true'}
      data-testid="entity-grid-favorite"
      aria-pressed={isFavorite}
      className={cn(
        "p-0.5 rounded-[5px] transition-colors hover:bg-muted flex-shrink-0",
        isFavorite ? "inline-flex" : "hidden group-hover:inline-flex"
      )}
    >
      <Star
        className={cn(
          "h-4 w-4",
          isFavorite
            ? "fill-yellow-400 text-yellow-400"
            : "text-muted-foreground/30 hover:text-muted-foreground/60"
        )}
      />
    </Button>
  );
}

interface CompanyCellProps<TEntity> {
  entity: TEntity;
  column: GridColumnDef<TEntity>;
  compact: boolean;
}

// Render company/name column (special case - first column with avatar)
function CompanyCell<TEntity>({ entity, column, compact }: Readonly<CompanyCellProps<TEntity>>) {
  const { config, state, setSelectedRows, actions } = useGridContext<TEntity>();
  const { selectedRows } = state;
  const entityId = config.getEntityId(entity);
  const name = config.getEntityName(entity);
  const initials = config.getEntityInitials?.(entity) || name.charAt(0).toUpperCase();
  const avatar = config.getEntityAvatar?.(entity);
  const subtitle = config.getEntitySubtitle?.(entity);
  const contextMenuItems = config.renderRowContextMenu?.(entity);

  const toggleRowSelected = (checked: boolean | 'indeterminate') => {
    const newSelected = new Set(selectedRows);
    if (checked) {
      newSelected.add(entityId);
    } else {
      newSelected.delete(entityId);
    }
    setSelectedRows(newSelected);
  };

  const cell = (
    <CellWrapper onClick={() => actions.onRowClick?.(entity)} isFirstColumn compact={compact}>
      <div className="flex items-center gap-2.5 min-w-0 flex-1 group">
        {config.enableRowSelection !== false && (
          <Checkbox
            checked={selectedRows.has(entityId)}
            onCheckedChange={toggleRowSelected}
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
        <FavoriteButton entity={entity} entityId={entityId} field={column.favoriteField} />
      )}
    </CellWrapper>
  );

  if (!contextMenuItems) return cell;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="block w-full h-full data-[state=open]:bg-muted/50">
        {cell}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">{contextMenuItems}</ContextMenuContent>
    </ContextMenu>
  );
}

/** Everything a type-specific cell renderer needs, resolved once per cell. */
interface CellRenderCtx {
  columnId: string;
  options: GridColumnDef<unknown>['options'];
  selectConfig: GridColumnDef<unknown>['selectConfig'];
  isFirstColumn: boolean;
  compact: boolean;
  isEditing: boolean;
  isPopoverOpen: boolean;
  /** `column.editable !== false` — gates every interactive editor below. */
  canEdit: boolean;
  value: unknown;
  entityId: string;
  /** Enter edit mode, honouring `config.enableInlineEditing`. */
  startEditing: () => void;
  /** Enter edit mode unconditionally (location cells). */
  forceStartEditing: () => void;
  persistValue: (newValue: unknown) => void;
  persistDate: (newValue: Date | null | undefined) => void;
  handleCommit: (finalValue?: unknown) => void;
  handleCancel: () => void;
  commitNumber: (finalValue: unknown) => void;
  setOpenPopover: (popover: OpenPopover | null) => void;
}

interface EditableCellProps {
  ctx: CellRenderCtx;
  renderEditor: () => React.ReactNode;
  children: React.ReactNode;
}

/** Shows the editor while the cell is in edit mode, otherwise the read-only display. */
function EditableCell({ ctx, renderEditor, children }: Readonly<EditableCellProps>) {
  if (ctx.isEditing) {
    return (
      <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact} isEditing>
        {renderEditor()}
      </CellWrapper>
    );
  }
  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact} onClick={ctx.startEditing}>
      {children}
    </CellWrapper>
  );
}

type TextCellType = 'email' | 'phone' | 'text' | 'url';

const TEXT_EDITORS: Record<TextCellType, React.ComponentType<EditorProps<string>>> = {
  email: EmailEditor,
  phone: PhoneEditor,
  text: TextEditor,
  url: UrlEditor,
};

function renderTextCell(type: TextCellType, ctx: CellRenderCtx) {
  const Editor = TEXT_EDITORS[type];
  const text = (ctx.value as string | undefined) || '';
  return (
    <EditableCell
      ctx={ctx}
      renderEditor={() => (
        <Editor value={text} onCommit={ctx.handleCommit} onCancel={ctx.handleCancel} />
      )}
    >
      <span className="text-[14px] text-foreground/80 truncate">{text || null}</span>
    </EditableCell>
  );
}

type NumberCellType = 'number' | 'currency' | 'percent';

interface NumberCellSpec {
  Editor: React.ComponentType<EditorProps<number | string>>;
  className: string;
  display: (value: unknown) => string | null;
}

const NUMBER_CELLS: Record<NumberCellType, NumberCellSpec> = {
  number: {
    Editor: NumberEditor,
    className: 'text-[14px] text-foreground/80',
    display: (v) => (typeof v === 'number' ? v.toLocaleString() : null),
  },
  currency: {
    Editor: CurrencyEditor,
    className: 'text-[14px] font-medium text-foreground',
    display: (v) => (typeof v === 'number' && v > 0 ? formatCurrency(v, { compact: true }) : null),
  },
  percent: {
    Editor: NumberEditor,
    className: 'text-[14px] text-foreground/80',
    display: (v) => (typeof v === 'number' ? formatPercent(v) : null),
  },
};

function renderNumberCell(type: NumberCellType, ctx: CellRenderCtx) {
  const { Editor, className, display } = NUMBER_CELLS[type];
  const { value } = ctx;
  return (
    <EditableCell
      ctx={ctx}
      renderEditor={() => (
        <Editor
          value={typeof value === 'number' && value > 0 ? value : ''}
          onCommit={ctx.commitNumber}
          onCancel={ctx.handleCancel}
        />
      )}
    >
      <span className={className}>{display(value)}</span>
    </EditableCell>
  );
}

function locationDisplayText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';
  const v = value as { city?: string; state?: string; country?: string };
  return [v.city, v.state, v.country].filter(Boolean).join(', ');
}

function renderLocationCell(ctx: CellRenderCtx) {
  const displayText = locationDisplayText(ctx.value);
  if (ctx.isEditing) {
    return (
      <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact} isEditing>
        <LocationEditor
          value={ctx.value as string | { city?: string; state?: string; country?: string } | null | undefined}
          onChange={ctx.persistValue}
          onCommit={() => setEditingCellValue(null)}
          onCancel={() => setEditingCellValue(null)}
        />
      </CellWrapper>
    );
  }
  return (
    <CellWrapper
      isFirstColumn={ctx.isFirstColumn}
      compact={ctx.compact}
      onClick={ctx.forceStartEditing}
    >
      {displayText ? (
        <span className="text-[14px] text-foreground/80 truncate">{displayText}</span>
      ) : null}
    </CellWrapper>
  );
}

function renderStarCell(ctx: CellRenderCtx) {
  const { value } = ctx;
  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
      <Button
        variant="ghost"
        size="icon"
        disabled={!ctx.canEdit}
        onClick={(e) => {
          e.stopPropagation();
          if (ctx.canEdit) ctx.persistValue(!value);
        }}
        className="p-0.5 rounded transition-colors hover:bg-muted disabled:opacity-70 disabled:cursor-default"
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
}

function renderStaticSelectValue(value: string | null | undefined, selectConfig: GridColumnDef<unknown>['selectConfig']) {
  if (!value) return null;
  const config = selectConfig?.[value];
  if (config) {
    return (
      <span className={cn('inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none', config.bg, config.color)}>
        {config.label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-secondary text-secondary-foreground">
      {value}
    </span>
  );
}

function renderSelectCell(multi: boolean, ctx: CellRenderCtx) {
  if (!ctx.canEdit) {
    return (
      <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
        {multi ? (
          <span className="flex items-center gap-1 flex-wrap">
            {((ctx.value as string[] | undefined) || []).map((v) => (
              <React.Fragment key={v}>{renderStaticSelectValue(v, ctx.selectConfig)}</React.Fragment>
            ))}
          </span>
        ) : (
          renderStaticSelectValue(ctx.value as string | null, ctx.selectConfig)
        )}
      </CellWrapper>
    );
  }
  const common = {
    onChange: ctx.persistValue,
    onCommit: () => {},
    onCancel: () => {},
    options: ctx.options || [],
    optionConfig: ctx.selectConfig,
    onOpenChange: (open: boolean) =>
      ctx.setOpenPopover(open ? { rowId: ctx.entityId, fieldId: ctx.columnId } : null),
  };
  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact} isEditing={ctx.isPopoverOpen}>
      {multi ? (
        <MultiSelectEditor value={(ctx.value as string[] | undefined) || []} {...common} />
      ) : (
        <SelectEditor value={ctx.value as string | null} {...common} />
      )}
    </CellWrapper>
  );
}

function renderCheckboxCell(ctx: CellRenderCtx) {
  if (!ctx.canEdit) {
    return (
      <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
        <Checkbox checked={!!ctx.value} disabled className="pointer-events-none opacity-70" />
      </CellWrapper>
    );
  }
  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
      <CheckboxEditor
        value={(ctx.value as boolean | undefined) || false}
        onChange={ctx.persistValue}
        onCommit={() => {}}
        onCancel={() => {}}
      />
    </CellWrapper>
  );
}

function renderDateCell(ctx: CellRenderCtx) {
  if (!ctx.canEdit) {
    const date = ctx.value ? new Date(ctx.value as string) : null;
    const text = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : null;
    return (
      <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
        {text ? <span className="text-[14px] text-foreground/80 truncate">{text}</span> : null}
      </CellWrapper>
    );
  }
  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
      <DateEditor
        value={ctx.value as Date | null | undefined}
        onChange={ctx.persistDate}
        onCommit={() => {}}
        onCancel={() => {}}
      />
    </CellWrapper>
  );
}

interface TeamMemberLite {
  userId: string;
  name: string | null;
  email?: string | null;
  picture?: string | null;
}

/** Shares its query cache with `MemberSelect` (same queryKey) — no extra fetch. */
function useTeamMembersForGrid(): TeamMemberLite[] {
  const { getClient } = useAppApiClient();
  const { data } = useQuery({
    queryKey: ['team-members', 'list'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: TeamMemberLite[] }>('/team-members');
    },
  });
  return data?.data ?? [];
}

interface MemberCellProps {
  ctx: CellRenderCtx;
}

/** Owner / account-manager column — shows the member's name + a picker, never a raw user id. */
function MemberCell({ ctx }: Readonly<MemberCellProps>) {
  const members = useTeamMembersForGrid();
  const userId = (ctx.value as string | null | undefined) || undefined;
  const selected = members.find((m) => m.userId === userId);
  const label = selected ? (selected.name?.trim() || selected.email || selected.userId) : null;

  if (!ctx.canEdit) {
    return (
      <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
        {label ? <span className="text-[14px] text-foreground/80 truncate">{label}</span> : null}
      </CellWrapper>
    );
  }

  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
      <MemberSelect
        value={userId}
        onChange={(next) => ctx.persistValue(next || null)}
        placeholder="—"
        variant="assignee"
      />
    </CellWrapper>
  );
}

function renderMemberCell(ctx: CellRenderCtx) {
  return <MemberCell ctx={ctx} />;
}

function renderDefaultCell(ctx: CellRenderCtx) {
  return (
    <CellWrapper isFirstColumn={ctx.isFirstColumn} compact={ctx.compact}>
      <span className="text-[14px] text-foreground/80">
        {(ctx.value as { toString(): string } | null | undefined)?.toString() || null}
      </span>
    </CellWrapper>
  );
}

// Render based on field type
function renderCellByType(type: GridColumnDef<unknown>['type'], ctx: CellRenderCtx) {
  switch (type) {
    case 'checkbox':
      return renderCheckboxCell(ctx);
    case 'star':
      return renderStarCell(ctx);
    case 'email':
    case 'phone':
    case 'text':
    case 'url':
      return renderTextCell(type, ctx);
    case 'number':
    case 'currency':
    case 'percent':
      return renderNumberCell(type, ctx);
    case 'date':
      return renderDateCell(ctx);
    case 'single-select':
      return renderSelectCell(false, ctx);
    case 'multi-select':
      return renderSelectCell(true, ctx);
    case 'location':
      return renderLocationCell(ctx);
    case 'member':
      return renderMemberCell(ctx);
    default:
      return renderDefaultCell(ctx);
  }
}

export function GridCell<TEntity>({
  entity,
  column,
  isFirstColumn,
}: Readonly<GridCellProps<TEntity>>) {
  const {
    config,
    state,
    setOpenPopover,
    updateEntityField,
    updateCustomFieldValue,
  } = useGridContext<TEntity>();

  const { editValue, openPopover } = state;
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

  const persistValue = (newValue: unknown) => {
    if (isLocalOnly) {
      updateCustomFieldValue(entityId, column.id, newValue);
    } else {
      void updateEntityField(entityId, column.id, newValue);
    }
  };

  const persistDate = (newValue: Date | null | undefined) => {
    if (isLocalOnly) {
      updateCustomFieldValue(entityId, column.id, newValue);
    } else {
      void updateEntityField(entityId, column.id, newValue?.toISOString() || null);
    }
  };

  // Handle commit for editors. Editors may pass the final value directly
  // (uncontrolled pattern) to avoid re-rendering the entire grid on each keystroke.
  const handleCommit = (finalValue?: unknown) => {
    const committedValue = finalValue !== undefined ? finalValue : editValue;
    if (isLocalOnly || committedValue !== value) {
      persistValue(committedValue);
    }
    setEditingCellValue(null);
  };

  const handleCancel = () => {
    setEditingCellValue(null);
  };

  const commitNumber = (finalValue: unknown) => {
    const newValue = Number.parseFloat(asText(finalValue ?? '')) || 0;
    if (newValue !== value) persistValue(newValue);
    setEditingCellValue(null);
  };

  const canEdit = column.editable !== false;

  const forceStartEditing = () => {
    if (!canEdit) return;
    setEditingCellValue({ rowId: entityId, fieldId: column.id });
  };

  const startEditing = () => {
    if (config.enableInlineEditing !== false) forceStartEditing();
  };

  // Custom render function takes precedence over type-based rendering
  if (column.render) {
    return (
      <CellWrapper isFirstColumn={isFirstColumn} compact={compact}>
        {column.render(entity, value)}
      </CellWrapper>
    );
  }

  if (column.type === 'company' && isFirstColumn) {
    return <CompanyCell entity={entity} column={column} compact={compact} />;
  }

  return renderCellByType(column.type, {
    columnId: column.id,
    options: column.options,
    selectConfig: column.selectConfig,
    isFirstColumn,
    compact,
    isEditing,
    isPopoverOpen,
    canEdit,
    value,
    entityId,
    startEditing,
    forceStartEditing,
    persistValue,
    persistDate,
    handleCommit,
    handleCancel,
    commitNumber,
    setOpenPopover,
  });
}
