
import React, { useState } from 'react';
import { X, Trash2, ListPlus, Mail, SquarePen, ChevronDown, type LucideIcon } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { cn } from '@/lib/utils';
import { useGridContext } from '../context';

interface GridSelectionBarProps {
  availableLists?: Array<{ id: string; title: string; color: string }>;
  onAddToList?: (listId: string) => Promise<void>;
  onSendEmail?: () => void;
  onBulkEdit?: () => void;
  onBulkDelete?: () => void | Promise<void>;
  onLoadLists?: () => Promise<void>;
  isDeleting?: boolean;
  listName?: string;
  /** Module-specific bulk actions, resolved against the current selection. */
  customActions?: Array<{ id: string; label: string; icon?: LucideIcon; onClick: () => void }>;
}

type TranslateFn = ReturnType<typeof useTranslations>;

// An action in the bar: a 32px outlined button on the bar's own background.
const ACTION_BUTTON_CLASS = 'h-8 gap-1.5 rounded-lg border border-border px-2.5 text-sm font-medium';

function bulkDeleteLabel(
  t: TranslateFn,
  isDeleting: boolean,
  listName: string | undefined,
  idleKey: 'sweep.entities.removeFromList' | 'sweep.entities.remove' | 'sweep.entities.delete',
): string {
  if (isDeleting) {
    return listName ? t('sweep.entities.removingEllipsis') : t('sweep.entities.deletingEllipsis');
  }
  return listName ? t(idleKey) : t('sweep.entities.delete');
}

interface AddToListPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTriggerClick: () => void;
  availableLists: NonNullable<GridSelectionBarProps['availableLists']>;
  onSelectList: (listId: string) => void;
}

function AddToListPopover({
  open,
  onOpenChange,
  onTriggerClick,
  availableLists,
  onSelectList,
}: Readonly<AddToListPopoverProps>) {
  const t = useTranslations();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={ACTION_BUTTON_CLASS}
          onClick={onTriggerClick}
        >
          <ListPlus className="h-4 w-4" />
          {t('sweep.entities.addToList')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={t('sweep.entities.searchListsPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('sweep.entities.noListsFoundDescription')}</CommandEmpty>
            <CommandGroup>
              {availableLists.map((list) => (
                <CommandItem
                  key={list.id}
                  onSelect={() => onSelectList(list.id)}
                  className="flex items-center gap-2"
                >
                  <div className={`w-3 h-3 rounded ${list.color}`} />
                  {list.title}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  listName?: string;
  isDeleting: boolean;
  onConfirm: () => void;
}

function BulkDeleteDialog({
  open,
  onOpenChange,
  selectedCount,
  listName,
  isDeleting,
  onConfirm,
}: Readonly<BulkDeleteDialogProps>) {
  const t = useTranslations();
  const isSingular = selectedCount === 1;
  let title: string;
  let description: string;
  if (listName) {
    title = t(
      isSingular
        ? 'sweep.entities.removeItemsFromListTitleSingular'
        : 'sweep.entities.removeItemsFromListTitlePlural',
      { count: selectedCount, listName },
    );
    description = t(
      isSingular
        ? 'sweep.entities.removeItemsDescriptionSingular'
        : 'sweep.entities.removeItemsDescriptionPlural',
    );
  } else {
    title = t(
      isSingular
        ? 'sweep.entities.deleteItemsTitleSingular'
        : 'sweep.entities.deleteItemsTitlePlural',
      { count: selectedCount },
    );
    description = t(
      isSingular
        ? 'sweep.entities.deleteItemsDescriptionSingular'
        : 'sweep.entities.deleteItemsDescriptionPlural',
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {title}
          </DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            {t('sweep.entities.cancel')}
          </Button>
          <Button
            variant={listName ? 'default' : 'destructive'}
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {bulkDeleteLabel(t, isDeleting, listName, 'sweep.entities.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GridSelectionBar({
  availableLists = [],
  onAddToList,
  onSendEmail,
  onBulkEdit,
  onBulkDelete,
  onLoadLists,
  isDeleting = false,
  listName,
  customActions = [],
}: Readonly<GridSelectionBarProps>) {
  const t = useTranslations();
  const { state, setSelectedRows } = useGridContext();
  const { selectedRows } = state;
  const [showAddToListPopover, setShowAddToListPopover] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (selectedRows.size === 0) {
    return null;
  }

  const handleAddToListClick = async () => {
    if (onLoadLists) {
      await onLoadLists();
    }
    setShowAddToListPopover(true);
  };

  const handleSelectList = async (listId: string) => {
    if (onAddToList) {
      await onAddToList(listId);
    }
    setShowAddToListPopover(false);
    setSelectedRows(new Set());
  };

  const handleConfirmDelete = async () => {
    if (onBulkDelete) {
      await onBulkDelete();
    }
    setShowDeleteConfirm(false);
  };

  return (
    // `--grid-hscrollbar-height` (set by GridTable) keeps the gap to the footer
    // the same whether or not the table shows a horizontal scrollbar.
    <div className="absolute bottom-[calc(4rem+var(--grid-hscrollbar-height,0px))] left-1/2 -translate-x-1/2 z-20 animate-in fade-in slide-in-from-bottom-2 duration-200">
      {/* Shadow: a hairline dark ring plus a soft drop that reaches every
          side (about 4px above, 7px beside, 12px below). */}
      <div className="flex items-center gap-2 bg-background border border-border rounded-xl p-[7px] shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_4px_12px_rgb(0_0_0/0.12)] dark:shadow-[0_0_0_1px_rgb(0_0_0/0.2),0_4px_12px_rgb(0_0_0/0.35)]">
        {/* Selection chip: count, label and the control that clears it */}
        <div className="flex h-8 items-center rounded-lg border border-dashed border-border bg-muted pl-[9px] pr-[5px]">
          <span className="inline-flex h-[18px] min-w-4 items-center justify-center rounded-[5px] bg-primary px-[5px] font-mono text-xs font-medium tabular-nums text-primary-foreground">
            {selectedRows.size}
          </span>
          <span className="ml-2 inline-block text-sm font-medium text-muted-foreground first-letter:uppercase">
            {t('sweep.entities.selectedLabel')}
          </span>
          <button
            type="button"
            aria-label={t('sweep.entities.clearSelection')}
            onClick={() => setSelectedRows(new Set())}
            className="ml-0.5 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="h-3.5 w-px bg-border" />

        {/* Add to list */}
        {onAddToList && (
          <AddToListPopover
            open={showAddToListPopover}
            onOpenChange={setShowAddToListPopover}
            onTriggerClick={handleAddToListClick}
            availableLists={availableLists}
            onSelectList={handleSelectList}
          />
        )}

        {/* Module-specific bulk actions (e.g. Move to CRM) */}
        {customActions.map((action) => (
          <Button
            key={action.id}
            variant="ghost"
            size="sm"
            className={ACTION_BUTTON_CLASS}
            onClick={action.onClick}
          >
            {action.icon && React.createElement(action.icon, { className: 'h-4 w-4' })}
            {action.label}
          </Button>
        ))}

        {/* Send email */}
        {onSendEmail && (
          <Button
            variant="ghost"
            size="sm"
            className={ACTION_BUTTON_CLASS}
            onClick={onSendEmail}
          >
            <Mail className="h-4 w-4" />
            {t('sweep.entities.sendEmail')}
          </Button>
        )}

        {/* Edit fields */}
        {onBulkEdit && (
          <Button
            variant="ghost"
            size="sm"
            className={ACTION_BUTTON_CLASS}
            onClick={onBulkEdit}
          >
            <SquarePen className="h-4 w-4" />
            {t('sweep.entities.editFields')}
          </Button>
        )}

        {/* More: Delete / Remove from list */}
        {onBulkDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* The chevron's glyph is inset 4px in its box, so the tighter
                  right padding leaves it as far from the edge as the label
                  is on the left. */}
              <Button variant="ghost" size="sm" className={cn(ACTION_BUTTON_CLASS, 'has-[>svg]:pr-1.5')}>
                {t('sweep.shared.more')}
                <ChevronDown className="size-4 translate-y-[0.5px] text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end">
              <DropdownMenuItem
                variant={listName ? 'default' : 'destructive'}
                disabled={isDeleting}
                onSelect={() => setShowDeleteConfirm(true)}
              >
                <Trash2 />
                {bulkDeleteLabel(t, isDeleting, listName, 'sweep.entities.removeFromList')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <BulkDeleteDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        selectedCount={selectedRows.size}
        listName={listName}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
