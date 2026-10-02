
import React, { useState } from 'react';
import { X, Trash2, ListPlus, Mail, SquarePen, type LucideIcon } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
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
}: AddToListPopoverProps) {
  const t = useTranslations();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-3 text-sm gap-1.5"
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
}: BulkDeleteDialogProps) {
  const t = useTranslations();
  const isSingular = selectedCount === 1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {listName
              ? t(
                  isSingular
                    ? 'sweep.entities.removeItemsFromListTitleSingular'
                    : 'sweep.entities.removeItemsFromListTitlePlural',
                  { count: selectedCount, listName },
                )
              : t(
                  isSingular
                    ? 'sweep.entities.deleteItemsTitleSingular'
                    : 'sweep.entities.deleteItemsTitlePlural',
                  { count: selectedCount },
                )}
          </DialogTitle>
          <DialogDescription>
            {listName
              ? t(
                  isSingular
                    ? 'sweep.entities.removeItemsDescriptionSingular'
                    : 'sweep.entities.removeItemsDescriptionPlural',
                )
              : t(
                  isSingular
                    ? 'sweep.entities.deleteItemsDescriptionSingular'
                    : 'sweep.entities.deleteItemsDescriptionPlural',
                )}
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
}: GridSelectionBarProps) {
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
    <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-20 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-1 bg-background border border-border rounded-xl shadow-lg px-2 py-1.5">
        <div className="flex items-center gap-1.5 px-2">
          <span className="text-sm font-medium">{selectedRows.size}</span>
          <span className="text-sm text-muted-foreground">{t('sweep.entities.selectedLabel')}</span>
        </div>

        <div className="w-px h-5 bg-border" />

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
            className="h-8 px-3 text-sm gap-1.5"
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
            className="h-8 px-3 text-sm gap-1.5"
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
            className="h-8 px-3 text-sm gap-1.5"
            onClick={onBulkEdit}
          >
            <SquarePen className="h-4 w-4" />
            {t('sweep.entities.editFields')}
          </Button>
        )}

        {/* Delete / Remove from list */}
        {onBulkDelete && (
          <Button
            variant="ghost"
            size="sm"
            className={
              listName
                ? "h-8 px-3 text-sm gap-1.5"
                : "h-8 px-3 text-sm gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20"
            }
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4" />
            {bulkDeleteLabel(t, isDeleting, listName, 'sweep.entities.removeFromList')}
          </Button>
        )}

        <div className="w-px h-5 bg-border" />

        {/* Clear selection */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => setSelectedRows(new Set())}
        >
          <X className="h-4 w-4" />
        </Button>
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
