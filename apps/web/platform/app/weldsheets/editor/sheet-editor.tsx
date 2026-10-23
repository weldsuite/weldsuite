import { useRef } from 'react';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { FormulaBar } from './formula-bar';
import { SheetGrid } from './grid/sheet-grid';
import type { SheetController } from './model/sheet-controller';
import { SheetTabs } from './sheet-tabs';
import { Toolbar } from './toolbar';

/** Toolbar, formula bar, grid and sheet tabs around one controller. */
export function SheetEditor({ controller }: { controller: SheetController }) {
  const barInputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <Toolbar controller={controller} />
        <FormulaBar controller={controller} inputRef={barInputRef} />
        <SheetGrid controller={controller} barInputRef={barInputRef} />
        <SheetTabs controller={controller} />
      </div>
    </TooltipProvider>
  );
}
