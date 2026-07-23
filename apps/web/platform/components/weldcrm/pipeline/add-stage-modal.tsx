
import { useState, ReactNode } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface AddStagePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddStage: (name: string, color: string) => void;
  children: ReactNode;
}

const STAGE_COLOR_META = [
  { key: 'blue', value: 'bg-blue-500', hex: '#3b82f6' },
  { key: 'purple', value: 'bg-purple-500', hex: '#a855f7' },
  { key: 'pink', value: 'bg-pink-500', hex: '#ec4899' },
  { key: 'red', value: 'bg-red-500', hex: '#ef4444' },
  { key: 'orange', value: 'bg-orange-500', hex: '#f97316' },
  { key: 'yellow', value: 'bg-yellow-500', hex: '#eab308' },
  { key: 'green', value: 'bg-green-500', hex: '#22c55e' },
  { key: 'teal', value: 'bg-teal-500', hex: '#14b8a6' },
  { key: 'cyan', value: 'bg-cyan-500', hex: '#06b6d4' },
  { key: 'indigo', value: 'bg-indigo-500', hex: '#6366f1' },
  { key: 'violet', value: 'bg-violet-500', hex: '#8b5cf6' },
  { key: 'fuchsia', value: 'bg-fuchsia-500', hex: '#d946ef' },
];

export function AddStagePopover({ open, onOpenChange, onAddStage, children }: AddStagePopoverProps) {
  const t = useTranslations();
  const STAGE_COLORS = STAGE_COLOR_META.map((c) => ({
    ...c,
    name: t(`sweep.weldcrm.addStageModal.colors.${c.key}`),
  }));
  const [stageName, setStageName] = useState('');
  const [selectedColor, setSelectedColor] = useState(STAGE_COLORS[0].value);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (stageName.trim()) {
      onAddStage(stageName.trim(), selectedColor);
      setStageName('');
      setSelectedColor(STAGE_COLORS[0].value);
      onOpenChange(false);
    }
  };

  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    setShowColorPicker(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="start">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex gap-2">
            <Popover open={showColorPicker} onOpenChange={setShowColorPicker}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="w-9 h-9 rounded-md flex-shrink-0 border border-input bg-transparent hover:border-ring/50 transition-colors p-1.5"
                  title={t('sweep.weldcrm.addStageModal.selectColor')}
                >
                  <div className={cn('w-full h-full rounded', selectedColor)} />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-2" align="start">
                <div className="grid grid-cols-6 gap-1.5">
                  {STAGE_COLORS.map((color) => (
                    <Button
                      key={color.value}
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleColorSelect(color.value)}
                      className={cn(
                        'w-6 h-6 rounded relative transition-all hover:scale-110',
                        color.value,
                        selectedColor === color.value && 'ring-2 ring-offset-1 ring-gray-900 dark:ring-gray-100'
                      )}
                      title={color.name}
                    >
                      {selectedColor === color.value && (
                        <Check className="absolute inset-0 m-auto h-3 w-3 text-white" />
                      )}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Input
              placeholder={t('sweep.weldcrm.addStageModal.newStageNamePlaceholder')}
              value={stageName}
              onChange={(e) => setStageName(e.target.value)}
              autoFocus
              className="h-9 flex-1 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="flex-1 shadow-none"
            >
              {t('sweep.weldcrm.addStageModal.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!stageName.trim()} className="flex-1">
              {t('sweep.weldcrm.addStageModal.add')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
