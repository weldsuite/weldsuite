
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
  onBulkDelete?: () => void;
  onLoadLists?: () => Promise<void>;
  isDeleting?: boolean;
  listName?: string;
  /** Module-specific bulk actions, resolved against the current selection. */
  customActions?: Array<{ id: string; label: string; icon?: LucideIcon; onClick: () => void }>;
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
          <Popover open={showAddToListPopover} onOpenChange={setShowAddToListPopover}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-sm gap-1.5"
                onClick={handleAddToListClick}
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
                        onSelect={() => handleSelectList(list.id)}
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
            {isDeleting
              ? (listName ? t('sweep.entities.removingEllipsis') : t('sweep.entities.deletingEllipsis'))
              : (listName ? t('sweep.entities.removeFromList') : t('sweep.entities.delete'))}
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

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {listName
                ? t(
                    selectedRows.size === 1
                      ? 'sweep.entities.removeItemsFromListTitleSingular'
                      : 'sweep.entities.removeItemsFromListTitlePlural',
                    { count: selectedRows.size, listName },
                  )
                : t(
                    selectedRows.size === 1
                      ? 'sweep.entities.deleteItemsTitleSingular'
                      : 'sweep.entities.deleteItemsTitlePlural',
                    { count: selectedRows.size },
                  )}
            </DialogTitle>
            <DialogDescription>
              {listName
                ? t(
                    selectedRows.size === 1
                      ? 'sweep.entities.removeItemsDescriptionSingular'
                      : 'sweep.entities.removeItemsDescriptionPlural',
                  )
                : t(
                    selectedRows.size === 1
                      ? 'sweep.entities.deleteItemsDescriptionSingular'
                      : 'sweep.entities.deleteItemsDescriptionPlural',
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
            >
              {t('sweep.entities.cancel')}
            </Button>
            <Button
              variant={listName ? 'default' : 'destructive'}
              onClick={handleConfirmDelete}
              disabled={isDeleting}
            >
              {isDeleting
                ? (listName ? t('sweep.entities.removingEllipsis') : t('sweep.entities.deletingEllipsis'))
                : (listName ? t('sweep.entities.remove') : t('sweep.entities.delete'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
