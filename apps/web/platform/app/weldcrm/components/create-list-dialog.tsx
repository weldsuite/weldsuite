
import { useTranslations } from '@weldsuite/i18n/client';
import { useState } from 'react';
import { LucideIcon, ChevronDown, Building, User } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';
import { coloredSquareColors, coloredSquareIcons } from '@/components/app-sidebar-layout';
import type { ListKind } from '@/hooks/queries/use-lists-queries';

interface CreateListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * `kind` is provided when the dialog shows the kind selector. Receivers
   * that don't care (e.g. the pipeline-creation flow) can ignore it.
   */
  onCreateList: (name: string, color: string, icon: LucideIcon, kind?: ListKind) => void;
  title?: string;
  buttonLabel?: string;
  placeholder?: string;
  /** When true, show a Companies/People toggle. Defaults to false. */
  showKindSelector?: boolean;
  /** Initial kind when the selector is shown. Defaults to 'company'. */
  defaultKind?: ListKind;
}

export function CreateListDialog({
  open,
  onOpenChange,
  onCreateList,
  title,
  buttonLabel,
  placeholder,
  showKindSelector = false,
  defaultKind = 'company',
}: CreateListDialogProps) {
  const t = useTranslations();
  const dialogTitle = title ?? t('crm.createListDialog.title');
  const dialogButtonLabel = buttonLabel ?? t('crm.createListDialog.createButton');
  const dialogPlaceholder = placeholder ?? t('crm.createListDialog.namePlaceholder');
  const [name, setName] = useState('');
  const [selectedColor, setSelectedColor] = useState(coloredSquareColors[0].value);
  const [selectedIcon, setSelectedIcon] = useState<LucideIcon>(coloredSquareIcons[0].value);
  const [selectedKind, setSelectedKind] = useState<ListKind>(defaultKind);
  const [colorPopoverOpen, setColorPopoverOpen] = useState(false);
  const [iconPopoverOpen, setIconPopoverOpen] = useState(false);

  const resetForm = () => {
    setName('');
    setSelectedColor(coloredSquareColors[0].value);
    setSelectedIcon(coloredSquareIcons[0].value);
    setSelectedKind(defaultKind);
  };

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreateList(name.trim(), selectedColor, selectedIcon, showKindSelector ? selectedKind : undefined);
    resetForm();
    onOpenChange(false);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  const SelectedIconComponent = selectedIcon;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {showKindSelector && (
            <div className="space-y-2">
              <Label>{t('crm.createListDialog.listTypeLabel')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setSelectedKind('company')}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                    selectedKind === 'company'
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Building className="h-4 w-4" />
                  {t('crm.createListDialog.listTypeCompanies')}
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setSelectedKind('person')}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                    selectedKind === 'person'
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <User className="h-4 w-4" />
                  {t('crm.createListDialog.listTypePeople')}
                </Button>
              </div>
            </div>
          )}

          {/* Name Input with Color and Icon dropdowns */}
          <div className="space-y-2">
            <Label htmlFor="list-name">{t('crm.createListDialog.nameLabel')}</Label>
            <div className="flex items-center gap-2">
              {/* Color Dropdown */}
              <Popover open={colorPopoverOpen} onOpenChange={setColorPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    type="button"
                    className={cn(
                      'w-9 h-9 rounded-md flex items-center justify-center shrink-0 transition-all hover:scale-105 border border-transparent hover:border-gray-300',
                      selectedColor
                    )}
                    title={t('sweep.weldcrm.createListDialog.changeColor')}
                  >
                    <SelectedIconComponent className="h-4 w-4 text-white" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <div className="grid grid-cols-6 gap-1.5">
                    {coloredSquareColors.map((color) => (
                      <Button
                        variant="ghost"
                        key={color.value}
                        type="button"
                        className={cn(
                          'w-7 h-7 rounded-md transition-all hover:scale-110',
                          color.value,
                          selectedColor === color.value && 'ring-2 ring-offset-1 ring-primary'
                        )}
                        onClick={() => {
                          setSelectedColor(color.value);
                          setColorPopoverOpen(false);
                        }}
                        title={color.label}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Icon Dropdown */}
              <Popover open={iconPopoverOpen} onOpenChange={setIconPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    type="button"
                    className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                    title={t('sweep.weldcrm.createListDialog.changeIcon')}
                  >
                    <SelectedIconComponent className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <div className="grid grid-cols-7 gap-1.5">
                    {coloredSquareIcons.map((iconOption) => {
                      const IconComponent = iconOption.value;
                      return (
                        <Button
                          variant="ghost"
                          key={iconOption.label}
                          type="button"
                          className={cn(
                            'w-7 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-accent',
                            selectedIcon === iconOption.value && 'bg-accent ring-2 ring-primary'
                          )}
                          onClick={() => {
                            setSelectedIcon(iconOption.value);
                            setIconPopoverOpen(false);
                          }}
                          title={iconOption.label}
                        >
                          <IconComponent className="h-4 w-4" />
                        </Button>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Name Input */}
              <Input
                id="list-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={dialogPlaceholder}
                autoFocus
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) {
                    handleCreate();
                  }
                }}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t('crm.createListDialog.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim()}>
            {dialogButtonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
