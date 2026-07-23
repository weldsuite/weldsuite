
import React, { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Plus, EyeOff, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';

interface StageHeaderProps {
  stage: {
    id: string;
    name: string;
    color?: string;
    count: number;
  };
  onAddDeal: (stageId: string, stageName: string) => void;
  confettiEnabled?: boolean;
  onConfettiChange?: (stageId: string, enabled: boolean) => void;
}

export function StageHeader({ stage, onAddDeal, confettiEnabled = false, onConfettiChange }: StageHeaderProps) {
  const t = useTranslations();
  const [trackTimeInStage, setTrackTimeInStage] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const headerRef = React.useRef<HTMLDivElement>(null);
  const [dropdownWidth, setDropdownWidth] = React.useState<number>(0);

  React.useEffect(() => {
    if (headerRef.current) {
      setDropdownWidth(headerRef.current.offsetWidth);
    }
  }, [isOpen]);

  return (
    <div className="mb-0">
      <div
        ref={headerRef}
        className={cn(
          "flex items-center justify-between mb-1 rounded-md px-2 py-1 -mx-2 transition-colors group",
          (isOpen || "hover:bg-gray-100 dark:hover:bg-secondary"),
          isOpen && "bg-gray-100 dark:bg-secondary"
        )}
      >
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2 ml-1">
              <div className={cn(
                "w-3 h-3 rounded",
                stage.color || "bg-gray-400"
              )} />
              <h3 className="font-medium text-sm text-gray-900 dark:text-foreground">
                {stage.name}
              </h3>
              <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px]">
                <span>{stage.count}</span>
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={4}
            alignOffset={-12}
            style={{ width: dropdownWidth > 0 ? `${dropdownWidth + 3}px` : undefined }}
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <div className="flex items-center gap-2">
                <div className={cn("w-3 h-3 rounded", stage.color || "bg-gray-400")} />
                <span className="text-sm font-medium">{stage.name}</span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between px-2 py-2">
              <span className="text-sm">{t('sweep.weldcrm.stageHeader.trackTimeInStage')}</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={trackTimeInStage}
                  onChange={(e) => setTrackTimeInStage(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
              </label>
            </div>
            <div className="flex items-center justify-between px-2 py-2">
              <span className="text-sm">{t('sweep.weldcrm.stageHeader.confetti')}</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={confettiEnabled}
                  onChange={(e) => onConfettiChange?.(stage.id, e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
              </label>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-sm">
              <EyeOff className="h-4 w-4 mr-2" />
              {t('sweep.weldcrm.stageHeader.hideStage')}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-sm text-red-600 dark:text-red-400">
              <Trash2 className="h-4 w-4 mr-2" />
              {t('sweep.weldcrm.stageHeader.deleteStage')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:bg-gray-200 dark:hover:bg-accent"
          onClick={() => onAddDeal(stage.id, stage.name)}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
